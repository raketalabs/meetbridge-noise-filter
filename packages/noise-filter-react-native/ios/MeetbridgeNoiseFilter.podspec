require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'MeetbridgeNoiseFilter'
  s.version = package['version']
  s.summary = package['description']
  s.license = { :type => 'MIT OR Apache-2.0' }
  s.author = 'MeetBridge'
  s.platforms = { :ios => '15.1' }
  s.source = { :path => '.' }
  s.source_files = '*.{h,m,mm,swift}'
  s.public_header_files = 'MeetbridgeDeepFilterCaptureProcessor.h', 'MeetbridgeDeepFilter.h'
  s.resource_bundles = {
    'MeetbridgeNoiseFilterResources' => ['../models/DeepFilterNet3_onnx.tar.gz']
  }
  s.dependency 'ExpoModulesCore'
  s.dependency 'livekit-react-native'
  s.frameworks = 'AVFAudio'
  s.libraries = 'c++'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17'
  }

  framework_path = File.join(__dir__, 'MeetbridgeDeepFilter.xcframework')
  if File.exist?(framework_path)
    s.vendored_frameworks = 'MeetbridgeDeepFilter.xcframework'
    s.pod_target_xcconfig['GCC_PREPROCESSOR_DEFINITIONS'] = '$(inherited) MEETBRIDGE_DEEPFILTER_AVAILABLE=1'
  end
end
