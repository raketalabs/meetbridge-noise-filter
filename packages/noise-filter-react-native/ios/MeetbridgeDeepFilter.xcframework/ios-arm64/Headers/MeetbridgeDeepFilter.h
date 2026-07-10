#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

void* df_create(const char* path, float attenuation_limit_db, const char* log_level);
size_t df_get_frame_length(void* state);
void df_set_atten_lim(void* state, float attenuation_limit_db);
float df_process_frame(void* state, float* input, float* output);
void df_free(void* state);

#ifdef __cplusplus
}
#endif
