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
import kotlin.math.max
import kotlin.math.min

data class NativeFilterStats(
  val avgFrameTimeMs: Double,
  val algorithmicLatencyMs: Double,
  val droppedFrames: Int,
  val overload: Boolean,
)

class DeepFilterCaptureProcessor(private val context: Context) {
  private var refCount = 0
  @Volatile private var enabled = true
  @Volatile private var nativeHandle = 0L
  private val stateLock = ReentrantLock()
  private val pendingSuppressionLevel = AtomicInteger(-1)
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
  private val overload = AtomicBoolean(false)
  private val enableTransition = AtomicInteger(0)
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
        nativeHandle = nativeCreate(copyModelAsset().absolutePath, levelToAttenuation(suppressionLevel))
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
    val wasEnabled = this.enabled
    this.enabled = enabled
    if (enabled != wasEnabled) enableTransition.set(if (enabled) 1 else -1)
  }

  private fun applyPendingEnableTransition() {
    when (enableTransition.getAndSet(0)) {
      1 -> {
        autoBypassed = false
        autoBypassFrames = 0
        recoveryWarmupFrames = 20
        resetOverloadGuard()
      }
      -1 -> {
        autoBypassed = false
        autoBypassFrames = 0
        recoveryWarmupFrames = 0
      }
    }
  }

  fun setSuppressionLevel(suppressionLevel: Int) {
    // The capture thread owns all mutations of a live core state.
    pendingSuppressionLevel.set(min(100, max(0, suppressionLevel)))
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
        "isEnabled" -> enabled && nativeHandle != 0L
        "getName" -> "MeetBridgeDeepFilterNet3"
        "initializeAudioProcessing" -> {
          sampleRate = (args?.getOrNull(0) as? Number)?.toInt() ?: 48_000
          channelCount = (args?.getOrNull(1) as? Number)?.toInt() ?: 1
          Unit
        }
        "resetAudioProcessing" -> {
          sampleRate = (args?.getOrNull(0) as? Number)?.toInt() ?: sampleRate
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
    if (!stateLock.tryLock()) return
    try {
      processAudioLocked(numFrames, buffer)
    } finally {
      stateLock.unlock()
    }
  }

  private fun processAudioLocked(numFrames: Int, buffer: ByteBuffer?) {
    applyPendingEnableTransition()
    if (!enabled || nativeHandle == 0L || buffer == null || sampleRate != 48_000 || numFrames != 480) return
    if (channelCount !in 1..8 || !buffer.isDirect || buffer.isReadOnly) {
      droppedFrames += 1
      return
    }
    if (autoBypassed) {
      autoBypassFrames += 1
      if (autoBypassFrames < 100) return
      autoBypassed = false
      autoBypassFrames = 0
      recoveryWarmupFrames = 20
      resetOverloadGuard()
    }
    val startedAt = System.nanoTime()
    val suppressionLevel = pendingSuppressionLevel.getAndSet(-1)
    if (suppressionLevel >= 0) nativeSetAttenuation(nativeHandle, levelToAttenuation(suppressionLevel))
    val shouldUseFilteredOutput = recoveryWarmupFrames <= 0
    val rawByteCount = numFrames * channelCount * 2
    if (!captureRawInput(buffer, rawByteCount)) {
      droppedFrames += 1
      return
    }
    val processed = nativeProcess(nativeHandle, buffer, numFrames, channelCount)
    if (!processed) {
      restoreRawInput(buffer, rawByteCount)
      droppedFrames += 1
      return
    }
    val frameTimeMs = (System.nanoTime() - startedAt) / 1_000_000.0
    processedFrames += 1
    averageFrameTimeMs += (frameTimeMs - averageFrameTimeMs) / processedFrames
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
    if (!shouldUseFilteredOutput || sustainedOverload) restoreRawInput(buffer, rawByteCount)
    if (recoveryWarmupFrames > 0) recoveryWarmupFrames -= 1
    if (sustainedOverload) {
      autoBypassed = true
      autoBypassFrames = 0
      overload.set(true)
    }
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
    enableTransition.set(0)
    autoBypassed = false
    autoBypassFrames = 0
    recoveryWarmupFrames = 0
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

  private fun restoreRawInput(buffer: ByteBuffer, byteCount: Int) {
    val originalPosition = buffer.position()
    val originalLimit = buffer.limit()
    try {
      buffer.limit(buffer.capacity())
      buffer.position(0)
      buffer.put(rawInputBytes, 0, byteCount)
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
