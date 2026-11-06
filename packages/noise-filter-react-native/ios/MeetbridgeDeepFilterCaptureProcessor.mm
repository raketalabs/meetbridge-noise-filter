#import "MeetbridgeDeepFilterCaptureProcessor.h"
#import "MeetbridgeDeepFilter.h"
#import <QuartzCore/QuartzCore.h>
#import <algorithm>
#import <atomic>
#import <cmath>
#import <vector>

namespace {
constexpr size_t kFrameLength = 480;
constexpr size_t kCoreDelayFrames = 3;
constexpr size_t kRawRingSlots = kCoreDelayFrames + 1;

// Only trim a quiet residual that the model has already strongly suppressed.
// A possible speech onset restores unity for the entire hop, including its start.
struct ResidualSuppression {
  float postGain = 1.0f;
  float pauseGain = 1.0f;
  NSInteger holdFrames = 25;

  void reset() {
    postGain = 1.0f;
    pauseGain = 1.0f;
    holdFrames = 25;
  }

  void process(float* output, const float* delayedRaw, size_t channels,
               bool postEnabled, bool pauseEnabled) {
    double rawPower = 0;
    double outputPower = 0;
    float peak = 0;
    const float normalization = 1.0f / (static_cast<float>(channels) * 32768.0f);
    for (size_t frame = 0; frame < kFrameLength; frame += 1) {
      float raw = 0;
      for (size_t channel = 0; channel < channels; channel += 1) {
        raw += delayedRaw[channel * kFrameLength + frame];
      }
      raw = std::clamp(raw * normalization, -1.0f, 1.0f);
      rawPower += static_cast<double>(raw) * raw;
      outputPower += static_cast<double>(output[frame]) * output[frame];
      peak = std::max(peak, std::abs(output[frame]));
    }
    const double rawDb = 10.0 * std::log10(std::max(rawPower / kFrameLength, 1e-12));
    const double outputDb = 10.0 * std::log10(std::max(outputPower / kFrameLength, 1e-12));
    const double peakDb = 20.0 * std::log10(std::max(static_cast<double>(peak), 1e-6));
    const double suppressionDb = rawDb - outputDb;
    if (suppressionDb < 12.0 || outputDb > -50.0 || peakDb > -38.0) {
      reset();
      return;
    }
    if (holdFrames > 0) {
      holdFrames -= 1;
      return;
    }
    const float postTarget = postEnabled
      ? static_cast<float>(std::pow(10.0, -std::clamp((suppressionDb - 12.0) / 12.0, 0.0, 1.0)
          * std::clamp((-50.0 - outputDb) / 10.0, 0.0, 1.0) / 20.0))
      : 1.0f;
    const float pauseTarget = pauseEnabled
      ? static_cast<float>(std::pow(10.0, -3.0 * std::clamp((-58.0 - outputDb) / 10.0, 0.0, 1.0) / 20.0))
      : 1.0f;
    const float previousGain = postGain * pauseGain;
    postGain += (postTarget - postGain) * (postTarget < postGain ? 0.064493f : 0.864665f);
    pauseGain += (pauseTarget - pauseGain) * (pauseTarget < pauseGain ? 0.064493f : 0.864665f);
    const float nextGain = postGain * pauseGain;
    for (size_t frame = 0; frame < kFrameLength; frame += 1) {
      const float progress = static_cast<float>(frame) / static_cast<float>(kFrameLength - 1);
      output[frame] *= previousGain + (nextGain - previousGain) * progress;
    }
  }
};

float attenuationForLevel(NSInteger level) {
  return -static_cast<float>(MAX(0, MIN(100, level))) * 0.8f;
}

NSString* modelPath() {
  NSArray<NSBundle*>* containerBundles = @[
    [NSBundle bundleForClass:[MBDeepFilterCaptureProcessor class]],
    [NSBundle mainBundle]
  ];
  for (NSBundle* containerBundle in containerBundles) {
    NSURL* resourceBundleURL = [containerBundle URLForResource:@"MeetbridgeNoiseFilterResources" withExtension:@"bundle"];
    if (resourceBundleURL) {
      NSBundle* resourceBundle = [NSBundle bundleWithURL:resourceBundleURL];
      NSString* bundledPath = [resourceBundle pathForResource:@"DeepFilterNet3_onnx" ofType:@"tar.gz"];
      if (bundledPath) return bundledPath;
    }
    NSString* directPath = [containerBundle pathForResource:@"DeepFilterNet3_onnx" ofType:@"tar.gz"];
    if (directPath) return directPath;
  }
  return nil;
}
}

@implementation MBDeepFilterCaptureProcessor {
  void* _state;
  NSInteger _channels;
  std::vector<float> _input;
  std::vector<float> _output;
  std::vector<float> _rawRing;
  std::vector<float> _transitionFade;
  std::vector<float> _lastOutput;
  size_t _rawWriteSlot;
  NSInteger _freshCoreFrames;
  BOOL _wasFiltered;
  BOOL _filteringRequested;
  BOOL _timelineNeedsReset;
  ResidualSuppression _residualSuppression;
  std::atomic_bool _postFilterEnabled;
  std::atomic_bool _pauseSuppressionEnabled;
  BOOL _appliedPostFilterEnabled;
  BOOL _appliedPauseSuppressionEnabled;
  std::atomic_bool _enabled;
  std::atomic_bool _overload;
  std::atomic<double> _averageFrameTimeMs;
  std::atomic_int _processedFrames;
  std::atomic_int _droppedFrames;
  NSInteger _guardFrameCount;
  double _rollingFrameTimeMs;
  NSInteger _overDeadlineStreak;
  NSInteger _sustainedHighAverageFrames;
  NSInteger _autoBypassFrames;
  NSInteger _recoveryWarmupFrames;
  BOOL _autoBypassed;
  std::atomic<NSInteger> _suppressionLevel;
  NSInteger _appliedSuppressionLevel;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _state = nullptr;
    _channels = 1;
    _enabled.store(true);
    _overload.store(false);
    _averageFrameTimeMs.store(0);
    _processedFrames.store(0);
    _droppedFrames.store(0);
    _rawWriteSlot = 0;
    _freshCoreFrames = 0;
    _wasFiltered = NO;
    _filteringRequested = NO;
    _timelineNeedsReset = NO;
    _postFilterEnabled.store(true);
    _pauseSuppressionEnabled.store(true);
    _appliedPostFilterEnabled = YES;
    _appliedPauseSuppressionEnabled = YES;
    _guardFrameCount = 0;
    _rollingFrameTimeMs = 0;
    _overDeadlineStreak = 0;
    _sustainedHighAverageFrames = 0;
    _autoBypassFrames = 0;
    _recoveryWarmupFrames = 0;
    _autoBypassed = NO;
    _suppressionLevel.store(80);
    _appliedSuppressionLevel = 80;
  }
  return self;
}

- (BOOL)isEnabled {
  return _enabled.load();
}

- (void)setEnabled:(BOOL)enabled {
  _enabled.store(enabled);
}

- (void)setPostFilterEnabled:(BOOL)enabled {
  _postFilterEnabled.store(enabled);
}

- (void)setPauseSuppressionEnabled:(BOOL)enabled {
  _pauseSuppressionEnabled.store(enabled);
}

- (void)setSuppressionLevel:(NSInteger)level {
  // The core is mutable: only the capture callback may update a live state.
  _suppressionLevel.store(MAX(0, MIN(100, level)));
}

- (NSDictionary<NSString*, id>*)availability {
#if !defined(MEETBRIDGE_DEEPFILTER_AVAILABLE)
  return @{ @"supported": @NO, @"reason": @"DeepFilterNet3 iOS XCFramework is not bundled in this development build." };
#else
  if (!modelPath()) {
    return @{ @"supported": @NO, @"reason": @"DeepFilterNet3 model asset is not bundled in this development build." };
  }
  return @{ @"supported": @YES };
#endif
}

- (void)audioProcessingInitializeWithSampleRate:(size_t)sampleRateHz channels:(size_t)channels {
#if !defined(MEETBRIDGE_DEEPFILTER_AVAILABLE)
  return;
#else
  [self audioProcessingRelease];
  if (sampleRateHz != 48000 || channels < 1) return;
  if ([[self availability][@"supported"] boolValue] == NO) return;
  NSString* path = modelPath();
  _appliedSuppressionLevel = _suppressionLevel.load();
  _state = df_create(path.UTF8String, attenuationForLevel(_appliedSuppressionLevel), nullptr);
  if (!_state || df_get_frame_length(_state) != 480) {
    if (_state) df_free(_state);
    _state = nullptr;
    return;
  }
  _channels = static_cast<NSInteger>(channels);
  _input.assign(kFrameLength, 0);
  _output.assign(kFrameLength, 0);
  _rawRing.assign(kRawRingSlots * channels * kFrameLength, 0);
  _lastOutput.assign(channels, 0);
  _transitionFade.resize(kFrameLength);
  for (size_t frame = 0; frame < kFrameLength; frame += 1) {
    _transitionFade[frame] = 0.5f - 0.5f * std::cos(3.14159265358979323846f
      * static_cast<float>(frame) / static_cast<float>(kFrameLength - 1));
  }
  _rawWriteSlot = 0;
  _freshCoreFrames = 0;
  _wasFiltered = NO;
  _filteringRequested = _enabled.load() && _appliedSuppressionLevel > 0;
  _timelineNeedsReset = NO;
  _residualSuppression.reset();
  _appliedPostFilterEnabled = _postFilterEnabled.load();
  _appliedPauseSuppressionEnabled = _pauseSuppressionEnabled.load();
  _averageFrameTimeMs.store(0);
  _processedFrames.store(0);
  _droppedFrames.store(0);
  _guardFrameCount = 0;
  _rollingFrameTimeMs = 0;
  _overDeadlineStreak = 0;
  _sustainedHighAverageFrames = 0;
  _autoBypassFrames = 0;
  _recoveryWarmupFrames = 0;
  _autoBypassed = NO;
#endif
}

- (void)audioProcessingProcess:(RTC_OBJC_TYPE(RTCAudioBuffer)*)audioBuffer {
#if !defined(MEETBRIDGE_DEEPFILTER_AVAILABLE)
  return;
#else
  if (!_state) return;
  if (audioBuffer.frames != kFrameLength || audioBuffer.channels != static_cast<size_t>(_channels)) {
    // Do not replay history across an unexpected capture format discontinuity.
    _timelineNeedsReset = YES;
    _wasFiltered = NO;
    _freshCoreFrames = 0;
    _residualSuppression.reset();
    return;
  }
  if (_timelineNeedsReset) {
    std::fill(_rawRing.begin(), _rawRing.end(), 0.0f);
    std::fill(_lastOutput.begin(), _lastOutput.end(), 0.0f);
    _rawWriteSlot = 0;
    _recoveryWarmupFrames = 20;
    _timelineNeedsReset = NO;
  }

  const NSInteger suppressionLevel = _suppressionLevel.load();
  const BOOL filteringRequested = _enabled.load() && suppressionLevel > 0;
  if (filteringRequested && !_filteringRequested) {
    _autoBypassed = NO;
    _autoBypassFrames = 0;
    _recoveryWarmupFrames = 20;
    _freshCoreFrames = 0;
    _guardFrameCount = 0;
    _rollingFrameTimeMs = 0;
    _overDeadlineStreak = 0;
    _sustainedHighAverageFrames = 0;
    _residualSuppression.reset();
  } else if (!filteringRequested) {
    _autoBypassed = NO;
    _autoBypassFrames = 0;
    _recoveryWarmupFrames = 0;
    _residualSuppression.reset();
  }
  _filteringRequested = filteringRequested;

  const BOOL postFilterEnabled = _postFilterEnabled.load();
  const BOOL pauseSuppressionEnabled = _pauseSuppressionEnabled.load();
  if (postFilterEnabled != _appliedPostFilterEnabled
      || pauseSuppressionEnabled != _appliedPauseSuppressionEnabled) {
    _residualSuppression.reset();
    _appliedPostFilterEnabled = postFilterEnabled;
    _appliedPauseSuppressionEnabled = pauseSuppressionEnabled;
  }

  if (_autoBypassed) {
    _autoBypassFrames += 1;
    if (_autoBypassFrames >= 100) {
      _autoBypassed = NO;
      _autoBypassFrames = 0;
      _recoveryWarmupFrames = 20;
      _freshCoreFrames = 0;
      _guardFrameCount = 0;
      _rollingFrameTimeMs = 0;
      _overDeadlineStreak = 0;
      _sustainedHighAverageFrames = 0;
      _residualSuppression.reset();
    }
  }

  // Every supported callback advances this timeline, including user/CPU bypass.
  // Keep each raw channel intact while the model consumes a normalized mono mix.
  const size_t channels = static_cast<size_t>(_channels);
  const size_t slotLength = channels * kFrameLength;
  float* currentRaw = _rawRing.data() + _rawWriteSlot * slotLength;
  const float* delayedRaw = _rawRing.data() + ((_rawWriteSlot + 1) % kRawRingSlots) * slotLength;
  std::fill(_input.begin(), _input.end(), 0.0f);
  for (size_t channel = 0; channel < channels; channel += 1) {
    const float* source = [audioBuffer rawBufferForChannel:static_cast<int>(channel)];
    for (size_t frame = 0; frame < kFrameLength; frame += 1) {
      currentRaw[channel * kFrameLength + frame] = source[frame];
      _input[frame] += source[frame];
    }
  }

  BOOL hasAlignedFilteredOutput = NO;
  // On disable/level zero, finish one positive-attenuation frame for an aligned
  // filtered-to-raw fade. Setting core attenuation to zero would remove its delay.
  const BOOL shouldProcess = (filteringRequested && !_autoBypassed) || _wasFiltered;
  if (shouldProcess) {
    const CFTimeInterval startedAt = CACurrentMediaTime();
    if (suppressionLevel > 0 && suppressionLevel != _appliedSuppressionLevel) {
      df_set_atten_lim(_state, attenuationForLevel(suppressionLevel));
      _appliedSuppressionLevel = suppressionLevel;
      _residualSuppression.reset();
    }
    const float normalization = 1.0f / (static_cast<float>(channels) * 32768.0f);
    for (size_t frame = 0; frame < kFrameLength; frame += 1) {
      _input[frame] = std::clamp(_input[frame] * normalization, -1.0f, 1.0f);
    }
    df_process_frame(_state, _input.data(), _output.data());
    const BOOL validOutput = std::all_of(_output.begin(), _output.end(), [](float sample) {
      return std::isfinite(sample);
    });
    if (validOutput) {
      _freshCoreFrames = MIN(_freshCoreFrames + 1, static_cast<NSInteger>(kCoreDelayFrames + 1));
      hasAlignedFilteredOutput = _freshCoreFrames > static_cast<NSInteger>(kCoreDelayFrames);
      if (filteringRequested && hasAlignedFilteredOutput && _recoveryWarmupFrames <= 0
          && (postFilterEnabled || pauseSuppressionEnabled)) {
        _residualSuppression.process(_output.data(), delayedRaw, channels,
          postFilterEnabled, pauseSuppressionEnabled);
      } else {
        _residualSuppression.reset();
      }
    } else {
      _droppedFrames.fetch_add(1);
      _freshCoreFrames = 0;
      _recoveryWarmupFrames = 20;
      _residualSuppression.reset();
    }

    const double elapsedMs = (CACurrentMediaTime() - startedAt) * 1000.0;
    const int count = _processedFrames.fetch_add(1) + 1;
    const double previous = _averageFrameTimeMs.load();
    _averageFrameTimeMs.store(previous + (elapsedMs - previous) / count);
    _guardFrameCount += 1;
    _rollingFrameTimeMs = _guardFrameCount == 1
      ? elapsedMs
      : _rollingFrameTimeMs * 0.95 + elapsedMs * 0.05;
    _overDeadlineStreak = elapsedMs > 9.5 ? _overDeadlineStreak + 1 : 0;
    _sustainedHighAverageFrames = _guardFrameCount > 100 && _rollingFrameTimeMs > 8.0
      ? _sustainedHighAverageFrames + 1
      : 0;
    const BOOL sustainedOverload = _guardFrameCount > 100
      && (_overDeadlineStreak >= 8 || _sustainedHighAverageFrames >= 50);
    if (sustainedOverload) {
      _autoBypassed = YES;
      _autoBypassFrames = 0;
      _overload.store(true);
    }
  } else {
    _freshCoreFrames = 0;
    _residualSuppression.reset();
  }

  const BOOL shouldUseFilteredOutput = filteringRequested && !_autoBypassed
    && hasAlignedFilteredOutput && _recoveryWarmupFrames <= 0;
  const BOOL changingOutput = shouldUseFilteredOutput != _wasFiltered;
  for (size_t channel = 0; channel < channels; channel += 1) {
    float* destination = [audioBuffer rawBufferForChannel:static_cast<int>(channel)];
    const float* raw = delayedRaw + channel * kFrameLength;
    const float boundaryCorrection = _lastOutput[channel] - raw[0];
    for (size_t frame = 0; frame < kFrameLength; frame += 1) {
      float sample = raw[frame];
      if (shouldUseFilteredOutput || (changingOutput && hasAlignedFilteredOutput)) {
        const float filtered = std::clamp(_output[frame], -1.0f, 1.0f) * 32767.0f;
        const float wet = changingOutput
          ? (shouldUseFilteredOutput ? _transitionFade[frame] : 1.0f - _transitionFade[frame])
          : 1.0f;
        sample += (filtered - sample) * wet;
      } else if (changingOutput) {
        // Invalid output cannot be faded as a waveform; preserve its last sample
        // at the boundary without repeating a stale speech frame.
        sample += boundaryCorrection * (1.0f - _transitionFade[frame]);
      }
      destination[frame] = std::clamp(sample, -32768.0f, 32767.0f);
    }
    _lastOutput[channel] = destination[kFrameLength - 1];
  }
  _wasFiltered = shouldUseFilteredOutput;
  _rawWriteSlot = (_rawWriteSlot + 1) % kRawRingSlots;
  if (shouldProcess && _recoveryWarmupFrames > 0) _recoveryWarmupFrames -= 1;
  if (!shouldUseFilteredOutput) _residualSuppression.reset();
#endif
}

- (void)audioProcessingRelease {
#if defined(MEETBRIDGE_DEEPFILTER_AVAILABLE)
  if (_state) df_free(_state);
#endif
  _state = nullptr;
  _input.clear();
  _output.clear();
  _rawRing.clear();
  _transitionFade.clear();
  _lastOutput.clear();
  _rawWriteSlot = 0;
  _freshCoreFrames = 0;
  _wasFiltered = NO;
  _filteringRequested = NO;
  _timelineNeedsReset = NO;
  _residualSuppression.reset();
}

- (NSDictionary<NSString*, id>*)statsAndClearOverload {
  return @{
    @"avgFrameTimeMs": @(_averageFrameTimeMs.load()),
    @"algorithmicLatencyMs": @30,
    @"droppedFrames": @(_droppedFrames.load()),
    @"overload": @(_overload.exchange(false))
  };
}

- (void)dealloc {
  [self audioProcessingRelease];
}
@end
