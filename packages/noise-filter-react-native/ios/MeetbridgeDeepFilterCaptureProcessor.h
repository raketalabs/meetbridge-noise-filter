#import <Foundation/Foundation.h>
#import "LKAudioProcessingAdapter.h"

@interface MBDeepFilterCaptureProcessor : NSObject <LKExternalAudioProcessingDelegate>

@property(nonatomic, assign, getter=isEnabled) BOOL enabled;

- (void)setSuppressionLevel:(NSInteger)level;
- (void)audioProcessingRelease;
- (NSDictionary<NSString*, id>* _Nonnull)availability;
- (NSDictionary<NSString*, id>* _Nonnull)statsAndClearOverload;

@end
