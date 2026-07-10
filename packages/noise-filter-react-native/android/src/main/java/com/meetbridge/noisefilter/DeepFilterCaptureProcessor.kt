package com.meetbridge.noisefilter

import android.content.Context
import java.io.File
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Proxy
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
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
  private var enabled = true
  private var nativeHandle = 0L
  private var processorProxy: Any? = null
  private var controller: Any? = null
  private var setCapturePostProcessor: java.lang.reflect.Method? = null
  private var sampleRate = 48_000
  private var channelCount = 1
  private var averageFrameTimeMs = 0.0
  private var processedFrames = 0
  private var droppedFrames = 0
  private val overload = AtomicBoolean(false)
  private var nativeLibraryLoaded = false

  fun availability(): Map<String, Any> {
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

  fun acquire(enabled: Boolean, suppressionLevel: Int) {
    val available = availability()["supported"] as? Boolean ?: false
    check(available) { availability()["reason"] as? String ?: "DeepFilterNet3 is unavailable." }
    this.enabled = enabled
    if (nativeHandle == 0L) {
      nativeHandle = nativeCreate(copyModelAsset().absolutePath, levelToAttenuation(suppressionLevel))
      check(nativeHandle != 0L) { "DeepFilterNet3 native state could not initialise." }
    }
    nativeSetAttenuation(nativeHandle, levelToAttenuation(suppressionLevel))
    if (refCount == 0) installCapturePostProcessor()
    refCount += 1
  }

  fun release() {
    refCount = max(0, refCount - 1)
    if (refCount == 0) uninstallCapturePostProcessor()
  }

  fun destroy() {
    refCount = 0
    uninstallCapturePostProcessor()
    if (nativeHandle != 0L) {
      nativeFree(nativeHandle)
      nativeHandle = 0L
    }
  }

  fun setEnabled(enabled: Boolean) {
    this.enabled = enabled
  }

  fun setSuppressionLevel(suppressionLevel: Int) {
    if (nativeHandle != 0L) nativeSetAttenuation(nativeHandle, levelToAttenuation(suppressionLevel))
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
    if (!enabled || nativeHandle == 0L || buffer == null || sampleRate != 48_000 || numFrames != 480) return
    val startedAt = System.nanoTime()
    val processed = nativeProcess(nativeHandle, buffer, numFrames, channelCount)
    if (!processed) {
      droppedFrames += 1
      return
    }
    val frameTimeMs = (System.nanoTime() - startedAt) / 1_000_000.0
    processedFrames += 1
    averageFrameTimeMs += (frameTimeMs - averageFrameTimeMs) / processedFrames
    if (frameTimeMs > 8.0 || averageFrameTimeMs > 8.0) {
      enabled = false
      overload.set(true)
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
