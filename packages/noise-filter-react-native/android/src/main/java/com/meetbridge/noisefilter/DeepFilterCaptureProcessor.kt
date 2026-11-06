package com.meetbridge.noisefilter

import android.content.Context
import java.io.File
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Proxy
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

data class NativeFilterStats(
  val avgFrameTimeMs: Double,
  val algorithmicLatencyMs: Double,
  val droppedFrames: Int,
  val overload: Boolean,
)

class DeepFilterCaptureProcessor(private val context: Context) {
  private var refCount = 0
  @Volatile private var enabled = true
  private var captureEnabled = true
  @Volatile private var nativeHandle = 0L
  private val stateLock = ReentrantLock()
  private val pendingSuppressionLevel = AtomicInteger(-1)
  private var activeSuppressionLevel = 80
  private val pendingStreamReset = AtomicBoolean(true)
  private val postFilterEnabled = AtomicBoolean(true)
  private val pauseSuppressionEnabled = AtomicBoolean(true)
  private val pendingQualityReset = AtomicBoolean(false)
  private var speechHoldFrames = 25
  private var postFilterGain = 1.0
  private var pauseSuppressionGain = 1.0
  private var qualityGainStart = 1f
  private var qualityGainEnd = 1f
  private var processorProxy: Any? = null
  private var controller: Any? = null
  private var setCapturePostProcessor: java.lang.reflect.Method? = null
  @Volatile private var sampleRate = 48_000
  @Volatile private var channelCount = 1
  @Volatile private var averageFrameTimeMs = 0.0
  private var processedFrames = 0
  @Volatile private var droppedFrames = 0
  private var guardFrameCount = 0
  private var rollingFrameTimeMs = 0.0
  private var overDeadlineStreak = 0
  private var sustainedHighAverageFrames = 0
  private var autoBypassFrames = 0
  private var recoveryWarmupFrames = 0
  private var autoBypassed = false
  private val rawInputBytes = ByteArray(480 * 8 * 2)
  // DF3 emits audio three hops behind capture. Keep bypass on that same
  // timeline, including while inference is disabled or cooling down.
  private val delayedRawBytes = Array(3) { ByteArray(480 * 8 * 2) }
  private var rawWriteIndex = 0
  private var rawHistoryFrames = 0
  private var timelineChannels = 0
  private var usingFilteredOutput = false
  private val lastOutputSamples = FloatArray(8)
  private val transitionCorrections = FloatArray(8)
  private val transitionFade = FloatArray(480) { sample ->
    ((1.0 - cos(Math.PI * sample / 479.0)) * 0.5).toFloat()
  }
  private val overload = AtomicBoolean(false)
  private var nativeLibraryLoaded = false

  @Synchronized fun availability(): Map<String, Any> {
    if (!loadNativeLibrary()) {
      return mapOf(
        "supported" to false,
        "reason" to "DeepFilterNet3 Android binaries are not bundled in this development build.",
      )
    }
    if (!hasModelAsset()) {
      return mapOf(
        "supported" to false,
        "reason" to "DeepFilterNet3 model asset is not bundled in this development build.",
      )
    }
    return try {
      resolveCaptureController()
      mapOf("supported" to true)
    } catch (error: Throwable) {
      mapOf(
        "supported" to false,
        "reason" to (error.message ?: "LiveKit capture post-processing is unavailable."),
      )
    }
  }

  @Synchronized fun acquire(enabled: Boolean, suppressionLevel: Int) {
    val availability = availability()
    check(availability["supported"] == true) { availability["reason"] as? String ?: "DeepFilterNet3 is unavailable." }
    if (refCount == 0) {
      stateLock.withLock {
        freeNativeState()
        resetRuntimeState()
        this.enabled = enabled
        captureEnabled = enabled
        activeSuppressionLevel = min(100, max(0, suppressionLevel))
        nativeHandle = nativeCreate(copyModelAsset().absolutePath, levelToAttenuation(activeSuppressionLevel))
        check(nativeHandle != 0L) { "DeepFilterNet3 native state could not initialise." }
        pendingSuppressionLevel.set(-1)
      }
      try {
        installCapturePostProcessor()
      } catch (error: Throwable) {
        stateLock.withLock { freeNativeState() }
        throw error
      }
    } else {
      setEnabled(enabled)
      setSuppressionLevel(suppressionLevel)
    }
    refCount += 1
  }

  @Synchronized fun release() {
    if (refCount <= 0) return
    if (refCount == 1) {
      uninstallCapturePostProcessor()
      stateLock.withLock { freeNativeState() }
    }
    refCount -= 1
  }

  @Synchronized fun destroy() {
    uninstallCapturePostProcessor()
    stateLock.withLock { freeNativeState() }
    refCount = 0
  }

  private fun freeNativeState() {
    if (nativeHandle != 0L) {
      nativeFree(nativeHandle)
      nativeHandle = 0L
    }
  }

  fun setEnabled(enabled: Boolean) {
    this.enabled = enabled
  }

  private fun applyPendingEnableTransition() {
    val nextEnabled = enabled
    if (captureEnabled == nextEnabled) return
    captureEnabled = nextEnabled
    autoBypassed = false
    autoBypassFrames = 0
    recoveryWarmupFrames = if (nextEnabled) 20 else 0
    if (nextEnabled) {
      resetOverloadGuard()
    }
  }

  fun setSuppressionLevel(suppressionLevel: Int) {
    // The capture thread owns all mutations of a live core state.
    pendingSuppressionLevel.set(min(100, max(0, suppressionLevel)))
  }

  fun setPostFilterEnabled(enabled: Boolean) {
    if (postFilterEnabled.getAndSet(enabled) != enabled) pendingQualityReset.set(true)
  }

  fun setPauseSuppressionEnabled(enabled: Boolean) {
    if (pauseSuppressionEnabled.getAndSet(enabled) != enabled) pendingQualityReset.set(true)
  }

  fun stats() = NativeFilterStats(
    avgFrameTimeMs = averageFrameTimeMs,
    algorithmicLatencyMs = 30.0,
    droppedFrames = droppedFrames,
    overload = overload.getAndSet(false),
  )

  private fun installCapturePostProcessor() {
    val target = resolveCaptureController()
    if (processorProxy == null) processorProxy = createProcessorProxy()
    setCapturePostProcessor?.invoke(target, processorProxy)
  }

  private fun uninstallCapturePostProcessor() {
    controller?.let { target -> setCapturePostProcessor?.invoke(target, null) }
  }

  private fun resolveCaptureController(): Any {
    if (controller != null && setCapturePostProcessor != null) return controller!!
    val liveKitClass = Class.forName("com.livekit.reactnative.LiveKitReactNative")
    val instance = liveKitClass.getField("INSTANCE").get(null)
    val nextController = liveKitClass.getMethod("getAudioProcessingController").invoke(instance)
    val interfaceClass = Class.forName("com.livekit.reactnative.audio.processing.AudioProcessorInterface")
    controller = nextController
    setCapturePostProcessor = nextController.javaClass.getMethod("setCapturePostProcessor", interfaceClass)
    return nextController
  }

  private fun createProcessorProxy(): Any {
    val interfaceClass = Class.forName("com.livekit.reactnative.audio.processing.AudioProcessorInterface")
    return Proxy.newProxyInstance(interfaceClass.classLoader, arrayOf(interfaceClass), InvocationHandler { _, method, args ->
      when (method.name) {
        // The hook must keep draining the delayed dry path when filtering is
        // switched off; stopping callbacks would jump ahead by 30 ms.
        "isEnabled" -> nativeHandle != 0L
        "getName" -> "MeetBridgeDeepFilterNet3"
        "initializeAudioProcessing" -> {
          sampleRate = (args?.getOrNull(0) as? Number)?.toInt() ?: 48_000
          channelCount = (args?.getOrNull(1) as? Number)?.toInt() ?: 1
          pendingStreamReset.set(true)
          Unit
        }
        "resetAudioProcessing" -> {
          sampleRate = (args?.getOrNull(0) as? Number)?.toInt() ?: sampleRate
          pendingStreamReset.set(true)
          Unit
        }
        "processAudio" -> {
          val numFrames = (args?.getOrNull(1) as? Number)?.toInt() ?: 0
          val buffer = args?.getOrNull(2) as? ByteBuffer
          processAudio(numFrames, buffer)
          Unit
        }
        else -> null
      }
    })
  }

  private fun processAudio(numFrames: Int, buffer: ByteBuffer?) {
    // Teardown may wait for inference; the real-time callback never waits for
    // model creation or teardown and leaves the original PCM untouched.
    if (!stateLock.tryLock()) {
      pendingStreamReset.set(true)
      return
    }
    try {
      processAudioLocked(numFrames, buffer)
    } finally {
      stateLock.unlock()
    }
  }

  private fun processAudioLocked(numFrames: Int, buffer: ByteBuffer?) {
    applyPendingEnableTransition()
    if (nativeHandle == 0L || buffer == null || sampleRate != 48_000 || numFrames != 480) {
      pendingStreamReset.set(true)
      return
    }
    val channels = channelCount
    if (channels !in 1..8 || !buffer.isDirect || buffer.isReadOnly) {
      droppedFrames += 1
      pendingStreamReset.set(true)
      return
    }
    val rawByteCount = numFrames * channels * 2
    if (!captureRawInput(buffer, rawByteCount)) {
      droppedFrames += 1
      pendingStreamReset.set(true)
      return
    }
    if (pendingStreamReset.getAndSet(false) || timelineChannels != channels) {
      resetAudioTimeline(channels)
      recoveryWarmupFrames = 20
      resetOverloadGuard()
    }
    val suppressionLevel = pendingSuppressionLevel.getAndSet(-1)
    // Preserve one last normally delayed core frame for a clean-to-dry fade.
    // Applying zero attenuation first would make the core return undelayed PCM.
    val finishFilteredHop = usingFilteredOutput && !autoBypassed && activeSuppressionLevel > 0
      && (!captureEnabled || suppressionLevel == 0)
    if (suppressionLevel >= 0) {
      if (suppressionLevel != activeSuppressionLevel) resetQualityState()
      if (activeSuppressionLevel == 0 && suppressionLevel > 0) {
        recoveryWarmupFrames = 20
        resetOverloadGuard()
      }
      activeSuppressionLevel = suppressionLevel
      if (!finishFilteredHop || suppressionLevel > 0) {
        nativeSetAttenuation(nativeHandle, levelToAttenuation(suppressionLevel))
      }
    }
    if (captureEnabled && autoBypassed) {
      autoBypassFrames += 1
      if (autoBypassFrames >= 100) {
        autoBypassed = false
        autoBypassFrames = 0
        recoveryWarmupFrames = 20
        resetOverloadGuard()
      }
    }

    var useFilteredOutput = false
    var filteredFrameAvailable = false
    var processed = false
    var startedAt = 0L
    val filterRequested = captureEnabled && !autoBypassed && activeSuppressionLevel > 0
    // At 0 dB attenuation the core itself bypasses without its normal delay.
    // Use our delayed dry path instead so that changing strength cannot skip
    // captured speech or blend audio from different points in time.
    if (filterRequested || finishFilteredHop) {
      startedAt = System.nanoTime()
      processed = nativeProcess(nativeHandle, buffer, numFrames, channels)
      if (processed) {
        filteredFrameAvailable = recoveryWarmupFrames <= 0
        useFilteredOutput = filterRequested && filteredFrameAvailable
        if (recoveryWarmupFrames > 0) recoveryWarmupFrames -= 1
      } else {
        droppedFrames += 1
        recoveryWarmupFrames = 20
      }
    }
    renderAlignedOutput(buffer, channels, useFilteredOutput, filteredFrameAvailable)
    if (finishFilteredHop && suppressionLevel == 0) nativeSetAttenuation(nativeHandle, 0f)
    if (processed) {
      // Include residual analysis, gain application, and transition rendering.
      // Pure bypass hops do not dilute the inference deadline statistics.
      val frameTimeMs = (System.nanoTime() - startedAt) / 1_000_000.0
      guardFrameCount += 1
      rollingFrameTimeMs = if (guardFrameCount == 1) {
        frameTimeMs
      } else {
        rollingFrameTimeMs * 0.95 + frameTimeMs * 0.05
      }
      overDeadlineStreak = if (frameTimeMs > 9.5) overDeadlineStreak + 1 else 0
      sustainedHighAverageFrames = if (guardFrameCount > 100 && rollingFrameTimeMs > 8.0) {
        sustainedHighAverageFrames + 1
      } else {
        0
      }
      val sustainedOverload = guardFrameCount > 100
        && (overDeadlineStreak >= 8 || sustainedHighAverageFrames >= 50)
      if (sustainedOverload) {
        if (useFilteredOutput) {
          // The current clean frame is already in the buffer. Reuse it for
          // the final fade instead of running another inference or hard-cutting.
          renderAlignedOutput(buffer, channels, false, true)
        }
        autoBypassed = true
        autoBypassFrames = 0
        overload.set(true)
      }
      val totalFrameTimeMs = (System.nanoTime() - startedAt) / 1_000_000.0
      processedFrames += 1
      averageFrameTimeMs += (totalFrameTimeMs - averageFrameTimeMs) / processedFrames
    }
    System.arraycopy(rawInputBytes, 0, delayedRawBytes[rawWriteIndex], 0, rawByteCount)
    rawWriteIndex = (rawWriteIndex + 1) % delayedRawBytes.size
    rawHistoryFrames = min(delayedRawBytes.size, rawHistoryFrames + 1)
  }

  private fun resetAudioTimeline(channels: Int) {
    rawWriteIndex = 0
    rawHistoryFrames = 0
    timelineChannels = channels
    usingFilteredOutput = false
    lastOutputSamples.fill(0f)
    resetQualityState()
  }

  private fun renderAlignedOutput(buffer: ByteBuffer, channels: Int, filtered: Boolean, filteredAvailable: Boolean) {
    val dry = delayedRawBytes[rawWriteIndex]
    val hasDelayedRaw = rawHistoryFrames == delayedRawBytes.size
    val transitioning = filtered != usingFilteredOutput
    if (transitioning && !filtered && !filteredAvailable) {
      for (channel in 0 until channels) {
        val dryStart = if (hasDelayedRaw) readPcm16(dry, channel * 2).toFloat() else 0f
        transitionCorrections[channel] = lastOutputSamples[channel] - dryStart
      }
    }
    val originalLimit = buffer.limit()
    try {
      buffer.limit(buffer.capacity())
      if (pendingQualityReset.getAndSet(false)) resetQualityState()
      if (filtered && hasDelayedRaw) {
        prepareQualityGain(buffer, dry, channels)
      } else {
        resetQualityState()
      }
      for (sample in 0 until 480) {
        val fade = transitionFade[sample]
        val qualityGain = qualityGainStart + (qualityGainEnd - qualityGainStart) * sample / 479f
        for (channel in 0 until channels) {
          val offset = (sample * channels + channel) * 2
          val raw = if (hasDelayedRaw) readPcm16(dry, offset).toFloat() else 0f
          val output = if (filtered) {
            // JNI exposes little-endian PCM regardless of ByteBuffer.order().
            val clean = readPcm16(buffer, offset) * qualityGain
            if (transitioning) raw + (clean - raw) * fade else clean
          } else if (transitioning && filteredAvailable) {
            val clean = readPcm16(buffer, offset).toFloat()
            clean + (raw - clean) * fade
          } else if (transitioning) {
            // When no new clean frame is available, decay only the boundary
            // discontinuity. Repeating an old clean frame would repeat speech.
            raw + transitionCorrections[channel] * (1f - fade)
          } else {
            raw
          }
          val pcm = output.coerceIn(-32768f, 32767f).toInt()
          buffer.put(offset, (pcm and 0xff).toByte())
          buffer.put(offset + 1, (pcm shr 8).toByte())
          if (sample == 479) lastOutputSamples[channel] = pcm.toFloat()
        }
      }
    } finally {
      buffer.limit(originalLimit)
    }
    usingFilteredOutput = filtered
  }

  private fun readPcm16(bytes: ByteArray, offset: Int): Int {
    return ((bytes[offset].toInt() and 0xff) or
      (bytes[offset + 1].toInt() shl 8)).toShort().toInt()
  }

  private fun readPcm16(buffer: ByteBuffer, offset: Int): Int {
    return ((buffer.get(offset).toInt() and 0xff) or
      (buffer.get(offset + 1).toInt() shl 8)).toShort().toInt()
  }

  private fun resetQualityState() {
    speechHoldFrames = 25
    postFilterGain = 1.0
    pauseSuppressionGain = 1.0
    qualityGainStart = 1f
    qualityGainEnd = 1f
  }

  private fun prepareQualityGain(buffer: ByteBuffer, dry: ByteArray, channels: Int) {
    var cleanPower = 0.0
    var dryPower = 0.0
    var cleanPeak = 0.0
    for (sample in 0 until 480) {
      val offset = sample * channels * 2
      // The native engine duplicates its mono result across output channels.
      val clean = readPcm16(buffer, offset) / 32768.0
      var raw = 0.0
      for (channel in 0 until channels) raw += readPcm16(dry, offset + channel * 2) / 32768.0
      raw /= channels
      cleanPower += clean * clean
      dryPower += raw * raw
      cleanPeak = max(cleanPeak, abs(clean))
    }
    val cleanDb = 10.0 * log10(max(cleanPower / 480.0, 1e-12))
    val dryDb = 10.0 * log10(max(dryPower / 480.0, 1e-12))
    val peakDb = 20.0 * log10(max(cleanPeak, 1e-6))
    val suppressionDb = dryDb - cleanDb
    // Only shape a very quiet residual already strongly rejected by DF3.
    // Restore unity for the entire first noncandidate hop, protecting speech
    // attacks, quiet syllables, and tails before applying a 250 ms hold.
    if (suppressionDb < 12.0 || cleanDb > -50.0 || peakDb > -38.0) {
      resetQualityState()
      return
    }
    if (speechHoldFrames > 0) {
      speechHoldFrames -= 1
      return
    }
    val postReductionDb = if (postFilterEnabled.get()) {
      ((suppressionDb - 12.0) / 12.0).coerceIn(0.0, 1.0) *
        ((-50.0 - cleanDb) / 10.0).coerceIn(0.0, 1.0)
    } else {
      0.0
    }
    val pauseReductionDb = if (pauseSuppressionEnabled.get()) {
      3.0 * ((-58.0 - cleanDb) / 10.0).coerceIn(0.0, 1.0)
    } else {
      0.0
    }
    qualityGainStart = (postFilterGain * pauseSuppressionGain).toFloat()
    postFilterGain = smoothQualityGain(postFilterGain, 10.0.pow(-postReductionDb / 20.0))
    pauseSuppressionGain = smoothQualityGain(pauseSuppressionGain, 10.0.pow(-pauseReductionDb / 20.0))
    qualityGainEnd = (postFilterGain * pauseSuppressionGain).toFloat()
  }

  private fun smoothQualityGain(current: Double, target: Double): Double {
    // 150 ms closing / 5 ms opening at the fixed 10 ms hop rate.
    val rate = if (target < current) 0.064493 else 0.864665
    return current + (target - current) * rate
  }

  private fun resetOverloadGuard() {
    guardFrameCount = 0
    rollingFrameTimeMs = 0.0
    overDeadlineStreak = 0
    sustainedHighAverageFrames = 0
  }

  private fun resetRuntimeState() {
    averageFrameTimeMs = 0.0
    processedFrames = 0
    droppedFrames = 0
    overload.set(false)
    autoBypassed = false
    autoBypassFrames = 0
    recoveryWarmupFrames = 20
    pendingStreamReset.set(true)
    resetAudioTimeline(0)
    resetOverloadGuard()
  }

  private fun captureRawInput(buffer: ByteBuffer, byteCount: Int): Boolean {
    if (byteCount <= 0 || byteCount > rawInputBytes.size || buffer.capacity() < byteCount) return false
    val originalPosition = buffer.position()
    val originalLimit = buffer.limit()
    return try {
      buffer.limit(buffer.capacity())
      buffer.position(0)
      buffer.get(rawInputBytes, 0, byteCount)
      true
    } finally {
      buffer.position(0)
      buffer.limit(originalLimit)
      buffer.position(originalPosition)
    }
  }

  private fun loadNativeLibrary(): Boolean {
    if (nativeLibraryLoaded) return true
    nativeLibraryLoaded = try {
      System.loadLibrary("meetbridge_noise_filter")
      true
    } catch (_: UnsatisfiedLinkError) {
      false
    }
    return nativeLibraryLoaded
  }

  private fun hasModelAsset() = try {
    context.assets.list("")?.contains("DeepFilterNet3_onnx.tar.gz") == true
  } catch (_: Throwable) {
    false
  }

  private fun copyModelAsset(): File {
    val output = File(context.filesDir, "meetbridge-deepfilternet/DeepFilterNet3_onnx.tar.gz")
    if (output.exists() && output.length() > 0) return output
    output.parentFile?.mkdirs()
    context.assets.open("DeepFilterNet3_onnx.tar.gz").use { input ->
      output.outputStream().use { outputStream -> input.copyTo(outputStream) }
    }
    return output
  }

  private fun levelToAttenuation(level: Int): Float {
    return -min(100, max(0, level)) * 0.8f
  }

  private external fun nativeCreate(modelPath: String, attenuationLimitDb: Float): Long
  private external fun nativeFree(handle: Long)
  private external fun nativeSetAttenuation(handle: Long, attenuationLimitDb: Float)
  private external fun nativeProcess(handle: Long, buffer: ByteBuffer, frames: Int, channels: Int): Boolean
}
