#import "MeetbridgeDeepFilterCaptureProcessor.h"
#import "MeetbridgeDeepFilter.h"
#import <QuartzCore/QuartzCore.h>
#import <atomic>
#import <vector>

namespace {
float attenuationForLevel(NSInteger level) {
  return -static_cast<float>(MAX(0, MIN(100, level))) * 0.8f;
}

NSString* modelPath() {
  NSBundle* classBundle = [NSBundle bundleForClass:[MBDeepFilterCaptureProcessor class]];
  NSURL* resourceBundleURL = [classBundle URLForResource:@"MeetbridgeNoiseFilterResources" withExtension:@"bundle"];
  NSBundle* resourceBundle = resourceBundleURL ? [NSBundle bundleWithURL:resourceBundleURL] : classBundle;
  return [resourceBundle pathForResource:@"DeepFilterNet3_onnx" ofType:@"tar.gz"];
}
}

@implementation MBDeepFilterCaptureProcessor {
  void* _state;
  NSInteger _channels;
  std::vector<float> _input;
  std::vector<float> _output;
  std::atomic_bool _enabled;
  std::atomic_bool _overload;
  std::atomic_double _averageFrameTimeMs;
  std::atomic_int _processedFrames;
  std::atomic_int _droppedFrames;
  NSInteger _suppressionLevel;
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
    _suppressionLevel = 80;
  }
  return self;
}

- (BOOL)isEnabled {
  return _enabled.load();
}

- (void)setEnabled:(BOOL)enabled {
  _enabled.store(enabled);
}

- (void)setSuppressionLevel:(NSInteger)level {
  _suppressionLevel = MAX(0, MIN(100, level));
#if defined(MEETBRIDGE_DEEPFILTER_AVAILABLE)
  if (_state) df_set_atten_lim(_state, attenuationForLevel(_suppressionLevel));
#endif
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
  if (sampleRateHz != 48000 || channels < 1) return;
  if ([[self availability][@"supported"] boolValue] == NO) return;
  [self audioProcessingRelease];
  NSString* path = modelPath();
  _state = df_create(path.UTF8String, attenuationForLevel(_suppressionLevel), nullptr);
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
#endif
}

- (void)audioProcessingProcess:(RTC_OBJC_TYPE(RTCAudioBuffer)*)audioBuffer {
#if !defined(MEETBRIDGE_DEEPFILTER_AVAILABLE)
  return;
#else
  if (!_enabled.load() || !_state || audioBuffer.frames != 480 || audioBuffer.channels < 1) return;
  CFTimeInterval startedAt = CACurrentMediaTime();
  const NSInteger channels = MIN(_channels, static_cast<NSInteger>(audioBuffer.channels));
  for (NSInteger frame = 0; frame < 480; frame += 1) {
    float mixed = 0;
    for (NSInteger channel = 0; channel < channels; channel += 1) {
      mixed += [audioBuffer rawBufferForChannel:static_cast<int>(channel)][frame];
    }
    _input[frame] = mixed / static_cast<float>(channels);
  }
  df_process_frame(_state, _input.data(), _output.data());
  for (NSInteger channel = 0; channel < channels; channel += 1) {
    float* destination = [audioBuffer rawBufferForChannel:static_cast<int>(channel)];
    for (NSInteger frame = 0; frame < 480; frame += 1) destination[frame] = _output[frame];
  }
  const double elapsedMs = (CACurrentMediaTime() - startedAt) * 1000.0;
  const int count = _processedFrames.fetch_add(1) + 1;
  const double previous = _averageFrameTimeMs.load();
  const double average = previous + (elapsedMs - previous) / count;
  _averageFrameTimeMs.store(average);
  if (elapsedMs > 8.0 || average > 8.0) {
    _enabled.store(false);
    _overload.store(true);
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
