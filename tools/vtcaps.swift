// Lists the Mac's VideoToolbox encoders and hardware decode support.
// Ground truth for what Safari (and any browser) can use on macOS.
// Run: swift vtcaps.swift

import VideoToolbox
import CoreMedia

func fourcc(_ c: CMVideoCodecType) -> String {
  let b = [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((c >> UInt32($0)) & 0xff))) }
  return String(b)
}

print("== Encoders (VTCopyVideoEncoderList)")
var list: CFArray?
VTCopyVideoEncoderList(nil, &list)
for case let e as [String: Any] in (list as? [Any]) ?? [] {
  let type = (e[kVTVideoEncoderList_CodecType as String] as? NSNumber).map { fourcc(CMVideoCodecType($0.uint32Value)) } ?? "?"
  let name = e[kVTVideoEncoderList_DisplayName as String] as? String ?? "?"
  let hw = (e[kVTVideoEncoderList_IsHardwareAccelerated as String] as? Bool) ?? false
  print("\(type)  hardware=\(hw)  \(name)")
}

VTRegisterSupplementalVideoDecoderIfAvailable(kCMVideoCodecType_VP9)
VTRegisterSupplementalVideoDecoderIfAvailable(kCMVideoCodecType_AV1)
print("\n== Hardware decode (VTIsHardwareDecodeSupported)")
let codecs: [(String, CMVideoCodecType)] = [
  ("H.264", kCMVideoCodecType_H264), ("HEVC", kCMVideoCodecType_HEVC),
  ("VP9", kCMVideoCodecType_VP9), ("AV1", kCMVideoCodecType_AV1),
]
for (name, type) in codecs {
  print("\(name)  hardware=\(VTIsHardwareDecodeSupported(type))")
}
