cmake_minimum_required(VERSION 3.22.1)
project(meetbridge_noise_filter)

add_library(meetbridge_noise_filter SHARED src/main/cpp/meetbridge_noise_filter_jni.cpp)
target_include_directories(meetbridge_noise_filter PRIVATE src/main/cpp/include)
target_link_options(meetbridge_noise_filter PRIVATE -Wl,-z,max-page-size=16384)

if(NOT DEFINED DEEPFILTER_LIBRARY)
  # Gradle invokes CMake once per ABI. The offline build script can still pass
  # an explicit path, while a normal Expo/Gradle build resolves the staged ABI.
  set(DEEPFILTER_LIBRARY "${CMAKE_CURRENT_LIST_DIR}/src/main/jniLibs/${ANDROID_ABI}/libdf.so")
endif()

if(NOT EXISTS "${DEEPFILTER_LIBRARY}")
  message(FATAL_ERROR "Missing staged libdf.so for ${ANDROID_ABI}: ${DEEPFILTER_LIBRARY}")
endif()

add_library(deepfilter SHARED IMPORTED)
set_target_properties(deepfilter PROPERTIES
  IMPORTED_LOCATION "${DEEPFILTER_LIBRARY}"
  IMPORTED_NO_SONAME TRUE
)
target_link_libraries(meetbridge_noise_filter deepfilter log)
