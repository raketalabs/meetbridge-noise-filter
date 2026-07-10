#include <jni.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>
#include "meetbridge_deepfilter.h"

namespace {
struct FilterState {
  void* core = nullptr;
  std::vector<float> input;
  std::vector<float> output;
};

FilterState* fromHandle(jlong handle) {
  return reinterpret_cast<FilterState*>(handle);
}
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_meetbridge_noisefilter_DeepFilterCaptureProcessor_nativeCreate(
    JNIEnv* env,
    jobject,
    jstring model_path,
    jfloat attenuation_limit_db) {
  const char* path = env->GetStringUTFChars(model_path, nullptr);
  if (!path) return 0;
  void* core = df_create(path, attenuation_limit_db, nullptr);
  env->ReleaseStringUTFChars(model_path, path);
  if (!core || df_get_frame_length(core) != 480) {
    if (core) df_free(core);
    return 0;
  }
  auto* state = new FilterState();
  state->core = core;
  state->input.resize(480);
  state->output.resize(480);
  return reinterpret_cast<jlong>(state);
}

extern "C" JNIEXPORT void JNICALL
Java_com_meetbridge_noisefilter_DeepFilterCaptureProcessor_nativeFree(
    JNIEnv*,
    jobject,
    jlong handle) {
  auto* state = fromHandle(handle);
  if (!state) return;
  if (state->core) df_free(state->core);
  delete state;
}

extern "C" JNIEXPORT void JNICALL
Java_com_meetbridge_noisefilter_DeepFilterCaptureProcessor_nativeSetAttenuation(
    JNIEnv*,
    jobject,
    jlong handle,
    jfloat attenuation_limit_db) {
  auto* state = fromHandle(handle);
  if (state && state->core) df_set_atten_lim(state->core, attenuation_limit_db);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_meetbridge_noisefilter_DeepFilterCaptureProcessor_nativeProcess(
    JNIEnv* env,
    jobject,
    jlong handle,
    jobject byte_buffer,
    jint frames,
    jint channels) {
  auto* state = fromHandle(handle);
  if (!state || !state->core || frames != 480 || channels < 1) return JNI_FALSE;
  // LiveKit's ExternalAudioProcessingFactory supplies interleaved PCM_16LE,
  // not Float32. Treating this as float would overrun the direct buffer and
  // corrupt audio, so conversion happens only in these preallocated vectors.
  auto* interleaved = static_cast<int16_t*>(env->GetDirectBufferAddress(byte_buffer));
  const auto requiredBytes = static_cast<jlong>(frames) * channels * static_cast<jlong>(sizeof(int16_t));
  if (!interleaved || env->GetDirectBufferCapacity(byte_buffer) < requiredBytes) return JNI_FALSE;
  for (int frame = 0; frame < frames; ++frame) {
    float sample = 0;
    for (int channel = 0; channel < channels; ++channel) {
      sample += static_cast<float>(interleaved[frame * channels + channel]) / 32768.0f;
    }
    state->input[frame] = sample / static_cast<float>(channels);
  }
  df_process_frame(state->core, state->input.data(), state->output.data());
  for (int frame = 0; frame < frames; ++frame) {
    const auto output = static_cast<int16_t>(std::lrint(std::clamp(state->output[frame], -1.0f, 1.0f) * 32767.0f));
    for (int channel = 0; channel < channels; ++channel) {
      interleaved[frame * channels + channel] = output;
    }
  }
  return JNI_TRUE;
}
