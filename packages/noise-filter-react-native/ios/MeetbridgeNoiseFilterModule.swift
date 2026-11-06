import ExpoModulesCore
import Foundation
import livekit_react_native

public final class MeetbridgeNoiseFilterModule: Module {
  private let processor = MBDeepFilterCaptureProcessor()
  private var leaseCount = 0
  private var attached = false

  public func definition() -> ModuleDefinition {
    Name("MeetbridgeNoiseFilter")
    Events("overload")

    AsyncFunction("getAvailability") {
      return self.processor.availability()
    }

    AsyncFunction("acquire") { (options: [String: Any]) in
      let enabled = options["enabled"] as? Bool ?? true
      let suppressionLevel = options["suppressionLevel"] as? Int ?? 80
      self.processor.setPostFilterEnabled(options["postFilter"] as? Bool ?? true)
      self.processor.setPauseSuppressionEnabled(options["pauseSuppression"] as? Bool ?? true)
      self.processor.isEnabled = enabled
      self.processor.setSuppressionLevel(suppressionLevel)
      if !self.attached {
        LKAudioProcessingManager.sharedInstance().addCapturePostProcessor(self.processor)
        self.attached = true
      }
      self.leaseCount += 1
    }

    AsyncFunction("release") {
      self.leaseCount = max(0, self.leaseCount - 1)
      if self.leaseCount == 0 && self.attached {
        LKAudioProcessingManager.sharedInstance().removeCapturePostProcessor(self.processor)
        self.attached = false
        // LiveKit removal waits for capture, but does not release the processor.
        self.processor.audioProcessingRelease()
      }
    }

    AsyncFunction("setEnabled") { (enabled: Bool) in
      self.processor.isEnabled = enabled
    }

    AsyncFunction("setSuppressionLevel") { (suppressionLevel: Int) in
      self.processor.setSuppressionLevel(suppressionLevel)
    }

    AsyncFunction("setEnhancementOptions") { (options: [String: Any]) in
      self.processor.setPostFilterEnabled(options["postFilter"] as? Bool ?? true)
      self.processor.setPauseSuppressionEnabled(options["pauseSuppression"] as? Bool ?? true)
    }

    AsyncFunction("getStats") {
      let stats = self.processor.statsAndClearOverload()
      if (stats["overload"] as? Bool) == true {
        self.sendEvent("overload", ["avgFrameTimeMs": stats["avgFrameTimeMs"] ?? 0])
      }
      return [
        "avgFrameTimeMs": stats["avgFrameTimeMs"] ?? 0,
        "algorithmicLatencyMs": stats["algorithmicLatencyMs"] ?? 30,
        "droppedFrames": stats["droppedFrames"] ?? 0
      ]
    }

    OnDestroy {
      if self.attached {
        LKAudioProcessingManager.sharedInstance().removeCapturePostProcessor(self.processor)
      }
      self.attached = false
      self.leaseCount = 0
      self.processor.audioProcessingRelease()
    }
  }
}
