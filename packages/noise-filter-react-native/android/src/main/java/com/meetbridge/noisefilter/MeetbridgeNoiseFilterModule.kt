package com.meetbridge.noisefilter

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MeetbridgeNoiseFilterModule : Module() {
  private val processor by lazy {
    DeepFilterCaptureProcessor(appContext.reactContext ?: throw IllegalStateException("React context is unavailable"))
  }

  override fun definition() = ModuleDefinition {
    Name("MeetbridgeNoiseFilter")
    Events("overload")

    AsyncFunction("getAvailability") {
      processor.availability()
    }

    AsyncFunction("acquire") { options: Map<String, Any?> ->
      processor.acquire(
        enabled = options["enabled"] as? Boolean ?: true,
        suppressionLevel = (options["suppressionLevel"] as? Number)?.toInt() ?: 80,
      )
    }

    AsyncFunction("release") {
      processor.release()
    }

    AsyncFunction("setEnabled") { enabled: Boolean ->
      processor.setEnabled(enabled)
    }

    AsyncFunction("setSuppressionLevel") { suppressionLevel: Int ->
      processor.setSuppressionLevel(suppressionLevel)
    }

    AsyncFunction("getStats") {
      val stats = processor.stats()
      if (stats.overload) {
        sendEvent("overload", mapOf("avgFrameTimeMs" to stats.avgFrameTimeMs))
      }
      mapOf(
        "avgFrameTimeMs" to stats.avgFrameTimeMs,
        "algorithmicLatencyMs" to stats.algorithmicLatencyMs,
        "droppedFrames" to stats.droppedFrames,
      )
    }

    OnDestroy {
      processor.destroy()
    }
  }
}
