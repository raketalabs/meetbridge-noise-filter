#import "MeetbridgeDeepFilterCaptureProcessor.h"
#import "MeetbridgeDeepFilter.h"
#import <QuartzCore/QuartzCore.h>
#import <algorithm>
#import <atomic>
#import <vector>

namespace {
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
  std::atomic_bool _enabled;
  std::atomic_bool _overload;
  std::atomic<double> _averageFrameTimeMs;
  std::atomic_int _processedFrames;
  std::atomic_int _droppedFrames;
  std::atomic_int _enableTransition;
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
    _enableTransition.store(0);
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
  const BOOL wasEnabled = _enabled.exchange(enabled);
  if (enabled != wasEnabled) _enableTransition.store(enabled ? 1 : -1);
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
  _input.assign(480, 0);
  _output.assign(480, 0);
  _averageFrameTimeMs.store(0);
  _processedFrames.store(0);
  _droppedFrames.store(0);
  _enableTransition.store(0);
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
  const int enableTransition = _enableTransition.exchange(0);
  if (enableTransition > 0) {
    _autoBypassed = NO;
    _autoBypassFrames = 0;
    _recoveryWarmupFrames = 20;
    _guardFrameCount = 0;
    _rollingFrameTimeMs = 0;
    _overDeadlineStreak = 0;
    _sustainedHighAverageFrames = 0;
  } else if (enableTransition < 0) {
    _autoBypassed = NO;
    _autoBypassFrames = 0;
    _recoveryWarmupFrames = 0;
  }
  if (!_enabled.load() || !_state || audioBuffer.frames != 480 || audioBuffer.channels < 1) return;
  if (_autoBypassed) {
    _autoBypassFrames += 1;
    if (_autoBypassFrames < 100) return;
    _autoBypassed = NO;
    _autoBypassFrames = 0;
    _recoveryWarmupFrames = 20;
    _guardFrameCount = 0;
    _rollingFrameTimeMs = 0;
    _overDeadlineStreak = 0;
    _sustainedHighAverageFrames = 0;
  }
  CFTimeInterval startedAt = CACurrentMediaTime();
  const NSInteger suppressionLevel = _suppressionLevel.load();
  if (suppressionLevel != _appliedSuppressionLevel) {
    df_set_atten_lim(_state, attenuationForLevel(suppressionLevel));
    _appliedSuppressionLevel = suppressionLevel;
  }
  const NSInteger channels = MIN(_channels, static_cast<NSInteger>(audioBuffer.channels));
  std::fill(_input.begin(), _input.end(), 0.0f);
  for (NSInteger channel = 0; channel < channels; channel += 1) {
    const float* source = [audioBuffer rawBufferForChannel:static_cast<int>(channel)];
    for (NSInteger frame = 0; frame < 480; frame += 1) {
      _input[frame] += source[frame];
    }
  }
  const float normalization = 1.0f / (static_cast<float>(channels) * 32768.0f);
  for (NSInteger frame = 0; frame < 480; frame += 1) {
    _input[frame] = std::clamp(_input[frame] * normalization, -1.0f, 1.0f);
  }
  df_process_frame(_state, _input.data(), _output.data());
  const double elapsedMs = (CACurrentMediaTime() - startedAt) * 1000.0;
  const int count = _processedFrames.fetch_add(1) + 1;
  const double previous = _averageFrameTimeMs.load();
  const double average = previous + (elapsedMs - previous) / count;
  _averageFrameTimeMs.store(average);
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
  const BOOL shouldUseFilteredOutput = !_autoBypassed && _recoveryWarmupFrames <= 0;
  if (_recoveryWarmupFrames > 0) _recoveryWarmupFrames -= 1;
  if (shouldUseFilteredOutput) {
    for (NSInteger channel = 0; channel < channels; channel += 1) {
      float* destination = [audioBuffer rawBufferForChannel:static_cast<int>(channel)];
      for (NSInteger frame = 0; frame < 480; frame += 1) {
        destination[frame] = std::clamp(_output[frame], -1.0f, 1.0f) * 32767.0f;
      }
    }
  }
#endif
}

- (void)audioProcessingRelease {
#if defined(MEETBRIDGE_DEEPFILTER_AVAILABLE)
  if (_state) df_free(_state);
#endif
  _state = nullptr;
  _input.clear();
  _output.clear();
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
