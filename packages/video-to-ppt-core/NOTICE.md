# Attribution

The video frame-difference strategy, dynamic-threshold strategy, and basic one-frame-per-slide workflow in this package are adapted from [`liwenka1/video-to-ppt`](https://github.com/liwenka1/video-to-ppt), reviewed at commit `af79bb9e7ef460b0162408fd866049edfd07da72`.

The upstream project is Copyright (c) 2025 李文凯 and licensed under the MIT License. The upstream license is reproduced in this package.

Desktop-specific changes include cancellable/timeout-safe media seeking, downscaled difference analysis, removal of the unsafe long-static-section early exit, binary PPTX output, and explicit lifecycle cleanup.
