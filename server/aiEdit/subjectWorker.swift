import AVFoundation
import CoreImage
// Local frame analysis. All coordinates saved to the track are upright, normalized and top-left based.
import Foundation
import ImageIO
import Vision

typealias Joints = [String: [Double]]
struct Frame: Encodable {
  var time: Double
  var body: Joints = [:]
  var hands: [String: Joints] = [:]
  var matte: String?
  var rect: [Double]?
  var handCrops: [String: HandCrop] = [:]
}
struct HandCrop: Encodable {
  var file: String
  var center: [Double]
  var across: [Double]
  var up: [Double]
  var scale: Double
}
// Upright hand crop for the local 3D landmark network. Preserve the exact inverse
// mapping so network depth/axes cannot accidentally remain in crop coordinates.
func handCrop(_ image: CIImage, _ joints: Joints, _ folder: URL, _ index: Int, _ side: String) throws -> HandCrop? {
  guard let wrist = joints["wrist"], let middle = joints["middleMCP"], wrist[2] > 0.25, middle[2] > 0.25 else { return nil }
  let w = image.extent.width, h = image.extent.height
  let dx = (middle[0]-wrist[0])*w, dy = (middle[1]-wrist[1])*h, length = hypot(dx,dy)
  guard length > 8 else { return nil }
  let up = [dx/length,dy/length], across = [-dy/length,dx/length]
  let points = joints.values.filter { $0[2] > 0.2 }.map { [$0[0]*w,$0[1]*h] }
  let xs = points.map { $0[0]*across[0]+$0[1]*across[1] }, ys = points.map { $0[0]*up[0]+$0[1]*up[1] }
  guard let x0=xs.min(), let x1=xs.max(), let y0=ys.min(), let y1=ys.max() else { return nil }
  let cx=(x0+x1)/2, cy=(y0+y1)/2+(y1-y0)*0.05, scale=max(x1-x0,y1-y0)*1.5/224
  let center=[across[0]*cx+up[0]*cy,across[1]*cx+up[1]*cy]
  let transform=CGAffineTransform(a:across[0]/scale,b:up[0]/scale,c:-across[1]/scale,d:-up[1]/scale,tx:112+(across[1]*h-cx)/scale,ty:112+(up[1]*h-cy)/scale)
  let crop=image.transformed(by:transform).composited(over:CIImage(color:.black).cropped(to:CGRect(x:0,y:0,width:224,height:224))).cropped(to:CGRect(x:0,y:0,width:224,height:224))
  let name=String(format:"pose%04d-%@.png",index,side)
  try renderer.writePNGRepresentation(of:crop,to:folder.appendingPathComponent(name),format:.RGBA8,colorSpace:CGColorSpace(name:CGColorSpace.sRGB)!)
  return HandCrop(file:name,center:center,across:across,up:up,scale:scale)
}
let unit = CGRect(x: 0, y: 0, width: 1, height: 1)
let renderer = CIContext(options: [.cacheIntermediates: false])
func fail(_ message: String) -> NSError {
  NSError(domain: "SubjectTrack", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
func xy(_ p: [Double]) -> CGPoint { CGPoint(x: p[0], y: p[1]) }
func distance(_ a: CGPoint, _ b: CGPoint) -> Double { hypot(a.x - b.x, a.y - b.y) }
func center(_ r: CGRect) -> CGPoint { CGPoint(x: r.midX, y: r.midY) }
func bounds(_ points: Joints) -> CGRect {
  let good = points.values.filter { $0[2] >= 0.16 }
  guard let left = good.map({ $0[0] }).min(), let top = good.map({ $0[1] }).min(),
    let right = good.map({ $0[0] }).max(), let bottom = good.map({ $0[1] }).max()
  else { return .zero }
  return CGRect(x: left, y: top, width: right - left, height: bottom - top)
}
func expanded(_ r: CGRect, _ x: Double, _ y: Double) -> CGRect {
  r.insetBy(dx: -x, dy: -y).intersection(unit)
}
func pixelRect(_ rect: CGRect, _ image: CIImage) -> CGRect {
  let e = image.extent
  return CGRect(
    x: rect.minX * e.width, y: (1 - rect.maxY) * e.height, width: rect.width * e.width,
    height: rect.height * e.height
  ).integral.intersection(e)
}
func normalized(_ rect: CGRect, _ e: CGRect) -> CGRect {
  CGRect(
    x: rect.minX / e.width, y: 1 - rect.maxY / e.height, width: rect.width / e.width,
    height: rect.height / e.height)
}
func cropped(_ image: CIImage, _ rect: CGRect) -> CIImage {
  image.cropped(to: rect).transformed(
    by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
}
func landmark(_ p: VNRecognizedPoint, _ r: CGRect) -> [Double] {
  [r.minX + p.x * r.width, r.minY + (1 - p.y) * r.height, Double(p.confidence)]
}
let bodyKeys: [(String, VNHumanBodyPoseObservation.JointName)] = [
  ("nose", .nose), ("neck", .neck), ("root", .root), ("leftShoulder", .leftShoulder),
  ("rightShoulder", .rightShoulder),
  ("leftElbow", .leftElbow), ("rightElbow", .rightElbow), ("leftWrist", .leftWrist),
  ("rightWrist", .rightWrist),
  ("leftHip", .leftHip), ("rightHip", .rightHip), ("leftKnee", .leftKnee),
  ("rightKnee", .rightKnee),
  ("leftAnkle", .leftAnkle), ("rightAnkle", .rightAnkle), ("leftEye", .leftEye),
  ("rightEye", .rightEye),
]
let handKeys: [(String, VNHumanHandPoseObservation.JointName)] = [
  ("wrist", .wrist), ("thumbCMC", .thumbCMC), ("thumbMP", .thumbMP), ("thumbIP", .thumbIP),
  ("thumbTip", .thumbTip),
  ("indexMCP", .indexMCP), ("indexPIP", .indexPIP), ("indexDIP", .indexDIP),
  ("indexTip", .indexTip),
  ("middleMCP", .middleMCP), ("middlePIP", .middlePIP), ("middleDIP", .middleDIP),
  ("middleTip", .middleTip),
  ("ringMCP", .ringMCP), ("ringPIP", .ringPIP), ("ringDIP", .ringDIP), ("ringTip", .ringTip),
  ("littleMCP", .littleMCP), ("littlePIP", .littlePIP), ("littleDIP", .littleDIP),
  ("littleTip", .littleTip),
]
struct Candidate {
  var joints: Joints
  var anchor: CGPoint
  var rect: CGRect
  var side: String = "unknown"
  var appearance: [Double] = []
}
func hands(_ image: CIImage, _ region: CGRect) throws -> [Candidate] {
  let pixels = pixelRect(region, image)
  let r = normalized(pixels, image.extent)
  let req = VNDetectHumanHandPoseRequest()
  req.maximumHandCount = 4
  try VNImageRequestHandler(ciImage: cropped(image, pixels)).perform([req])
  return (req.results ?? []).compactMap { obs in
    var pts = Joints()
    for (name, key) in handKeys {
      if let p = try? obs.recognizedPoint(key), p.confidence >= 0.12 { pts[name] = landmark(p, r) }
    }
    guard let wrist = pts["wrist"], let palm = pts["middleMCP"] else { return nil }
    let a = CGPoint(x: (wrist[0] + palm[0]) / 2, y: (wrist[1] + palm[1]) / 2)
    return Candidate(
      joints: pts, anchor: a, rect: bounds(pts),
      side: obs.chirality == .left ? "left" : obs.chirality == .right ? "right" : "unknown")
  }
}
func bodies(_ image: CIImage, region: CGRect) throws -> [Candidate] {
  let pixels = pixelRect(region, image)
  let r = normalized(pixels, image.extent)
  let req = VNDetectHumanBodyPoseRequest()
  try VNImageRequestHandler(ciImage: cropped(image, pixels)).perform([req])
  // Shirt and trouser colours disambiguate nearby skeletons. Landmarks are in display coordinates.
  let thumb = image.transformed(
    by: CGAffineTransform(scaleX: 240 / image.extent.width, y: 240 / image.extent.width))
  let cg = renderer.createCGImage(
    thumb, from: thumb.extent.integral, format: .RGBA8,
    colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
  let bytes = cg?.dataProvider?.data
  return (req.results ?? []).compactMap { obs in
    var pts = Joints()
    for (name, key) in bodyKeys {
      if let p = try? obs.recognizedPoint(key), p.confidence >= 0.12 { pts[name] = landmark(p, r) }
    }
    guard let root = pts["root"], let neck = pts["neck"] else { return nil }
    var appearance = [Double]()
    if let cg, let bytes, let raw = CFDataGetBytePtr(bytes) {
      for (a, b) in [("neck", "root"), ("leftHip", "leftKnee"), ("rightHip", "rightKnee")] {
        guard let p = pts[a], let q = pts[b] else {
          appearance += [-1, -1, -1]
          continue
        }
        let x = Int((p[0] + q[0]) * 0.5 * Double(cg.width))
        let y = Int((p[1] + q[1]) * 0.5 * Double(cg.height))
        for channel in 0..<3 {
          var samples = [UInt8]()
          for dy in -1...1 {
            for dx in -1...1 {
              let off =
                max(0, min(cg.height - 1, y + dy)) * cg.bytesPerRow + max(
                  0, min(cg.width - 1, x + dx)) * 4
              samples.append(raw[off + channel])
            }
          }
          appearance.append(Double(samples.sorted()[4]) / 255)
        }
      }
    }
    return Candidate(
      joints: pts, anchor: CGPoint(x: (root[0] + neck[0]) / 2, y: (root[1] + neck[1]) / 2),
      rect: bounds(pts), appearance: appearance)
  }
}
struct Identity {
  let seed: CGPoint
  var last: Candidate?
  var seen: Double?
  var signature: [Double] = []
  mutating func select(_ items: [Candidate], at time: Double) -> Candidate? {
    // Do not jump to a bystander after the selected subject leaves the shot.
    if time - (seen ?? 0) > 0.6 { return nil }
    let target = last?.anchor ?? seed
    var ranked = [(Candidate, Double)]()
    for c in items {
      let d = distance(c.anchor, target)
      if let last {
        if d >= max(0.08, min(0.24, last.rect.height * 0.55)) { continue }
      } else if !expanded(c.rect, 0.075, 0.075).contains(target) {
        continue
      }
      let diffs = zip(signature, c.appearance).compactMap { a, b in
        a < 0 || b < 0 ? nil : abs(a - b)
      }
      let error = diffs.reduce(0, +) / Double(max(1, diffs.count))
      if error > 0.24 { continue }
      ranked.append((c, d + error * 0.55))
    }
    ranked.sort { $0.1 < $1.1 }
    guard let (first, score) = ranked.first else { return nil }
    if ranked.count > 1 && ranked[1].1 - score < 0.012 { return nil }
    if last == nil { signature = first.appearance }
    last = first
    seen = time
    return first
  }
}
func assignHands(_ candidates: [Candidate], to body: Candidate) -> [String: Joints] {
  var pairs = [(Double, String, Int)]()
  for side in ["left", "right"] {
    guard let wrist = body.joints[side + "Wrist"], wrist[2] >= 0.18 else { continue }
    for (i, h) in candidates.enumerated() {
      let d = distance(xy(wrist), xy(h.joints["wrist"]!))
      if d < max(0.03, body.rect.height * 0.14) { pairs.append((d, side, i)) }
    }
  }
  var result = [String: Joints]()
  var used = Set<Int>()
  for (_, side, i) in pairs.sorted(by: { $0.0 < $1.0 })
  where result[side] == nil && !used.contains(i) {
    result[side] = candidates[i].joints
    used.insert(i)
  }
  return result
}
@available(macOS 14, *)
func selectInstance(
  _ result: VNInstanceMaskObservation, region r: CGRect, votes: [[Double]], isolate: Bool
) -> (Int, CIImage?)? {
  let labels = result.instanceMask
  CVPixelBufferLockBaseAddress(labels, .readOnly)
  let w = CVPixelBufferGetWidth(labels)
  let h = CVPixelBufferGetHeight(labels)
  let stride = CVPixelBufferGetBytesPerRow(labels)
  let ptr = CVPixelBufferGetBaseAddress(labels)!.assumingMemoryBound(to: UInt8.self)
  var counts = [Int: Double]()
  for p in votes where p[2] >= 0.15 && r.contains(xy(p)) {
    let x = min(w - 1, Int((p[0] - r.minX) / r.width * Double(w)))
    let y = min(h - 1, Int((p[1] - r.minY) / r.height * Double(h)))
    let id = Int(ptr[y * stride + x])
    if id > 0 { counts[id, default: 0] += p[2] }
  }
  guard let id = counts.max(by: { $0.value < $1.value })?.key else {
    CVPixelBufferUnlockBaseAddress(labels, .readOnly)
    return nil
  }
  var owner: CIImage?
  if isolate && result.allInstances.count > 1 {
    // Soft per-instance probabilities can be translucent even on opaque clothes.
    // Separate neighbouring people by identity; estimate the visible edge independently.
    var alpha = [UInt8](repeating: 0, count: w * h)
    for y in 0..<h {
      for x in 0..<w where Int(ptr[y * stride + x]) == id { alpha[y * w + x] = 255 }
    }
    let provider = CGDataProvider(data: Data(alpha) as CFData)!
    let cg = CGImage(
      width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w,
      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0),
      provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)!
    owner = CIImage(cgImage: cg)
  }
  CVPixelBufferUnlockBaseAddress(labels, .readOnly)
  return (id, owner)
}
@available(macOS 14, *)
func matte(
  _ image: CIImage, region: CGRect, person: Bool, votes: [[Double]], folder: URL, index: Int
) throws -> (String, [Double])? {
  let pixels = pixelRect(region, image)
  let r = normalized(pixels, image.extent)
  let handler = VNImageRequestHandler(ciImage: cropped(image, pixels))
  let foreground = VNGenerateForegroundInstanceMaskRequest()
  try handler.perform([foreground])
  guard let result = foreground.results?.first,
    let (id, _) = selectInstance(result, region: r, votes: votes, isolate: false)
  else { return nil }
  var mask = CIImage(
    cvPixelBuffer: try result.generateScaledMaskForImage(
      forInstances: IndexSet(integer: id), from: handler))
  if person {
    let people = VNGeneratePersonInstanceMaskRequest()
    try handler.perform([people])
    guard let peopleResult = people.results?.first,
      let (_, owner) = selectInstance(peopleResult, region: r, votes: votes, isolate: true)
    else { return nil }
    if let owner {
      let scaled = owner.transformed(
        by: CGAffineTransform(
          scaleX: mask.extent.width / owner.extent.width,
          y: mask.extent.height / owner.extent.height))
      mask = mask.applyingFilter(
        "CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: scaled])
    }
  }
  let scale = min(1, 768 / max(image.extent.width, image.extent.height))
  let shaped = mask.applyingFilter("CIMaskToAlpha").transformed(
    by: CGAffineTransform(
      scaleX: scale * pixels.width / mask.extent.width,
      y: scale * pixels.height / mask.extent.height))
  let name = String(format: "m%04d.png", index)
  try renderer.writePNGRepresentation(
    of: shaped, to: folder.appendingPathComponent(name), format: .RGBA8,
    colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
  return (name, [r.minX, r.minY, r.width, r.height])
}
func orientation(_ t: CGAffineTransform) throws -> CGImagePropertyOrientation {
  switch [t.a, t.b, t.c, t.d].map({ Int($0.rounded()) }) {
  case [1, 0, 0, 1]: return .up
  case [-1, 0, 0, 1]: return .upMirrored
  case [-1, 0, 0, -1]: return .down
  case [1, 0, 0, -1]: return .downMirrored
  case [0, 1, -1, 0]: return .right
  case [0, -1, 1, 0]: return .left
  case [0, 1, 1, 0]: return .leftMirrored
  case [0, -1, -1, 0]: return .rightMirrored
  default: throw fail("不支持此视频的显示方向")
  }
}
@available(macOS 14, *)
func run() throws {
  let a = CommandLine.arguments
  guard a.count == 8, let start = Double(a[4]), let length = Double(a[5]), let x = Double(a[6]),
    let y = Double(a[7])
  else { throw fail("参数无效") }
  let handOnly = a[3] == "hand"
  let folder = URL(fileURLWithPath: a[2])
  let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
  guard let track = asset.tracks(withMediaType: .video).first else { throw fail("没有视频轨") }
  let display = try orientation(track.preferredTransform)
  let reader = try AVAssetReader(asset: asset)
  let src = AVAssetReaderTrackOutput(
    track: track,
    outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
  let begin = max(0, start - 1)
  reader.timeRange = CMTimeRange(
    start: CMTime(seconds: begin, preferredTimescale: 60000),
    end: CMTime(seconds: start + length, preferredTimescale: 60000))
  reader.add(src)
  guard reader.startReading() else { throw reader.error ?? fail("解码失败") }
  var identity = Identity(seed: CGPoint(x: x, y: y))
  var frames = [Frame]()
  var size = [Int]()
  var fixedSide: String?
  let firstPTS = track.timeRange.start.seconds
  func analyze(_ sample: CMSampleBuffer) throws {
    guard let buffer = CMSampleBufferGetImageBuffer(sample) else { return }
    let time = max(0, CMSampleBufferGetPresentationTimeStamp(sample).seconds - start)
    guard time < length else { return }
    guard frames.count < 720 else { throw fail("单次最多 720 帧，请缩短片段") }
    let oriented = CIImage(cvPixelBuffer: buffer).oriented(display)
    let image = oriented.transformed(
      by: CGAffineTransform(translationX: -oriented.extent.minX, y: -oriented.extent.minY))
    size = [Int(image.extent.width), Int(image.extent.height)]
    var frame = Frame(time: time)
    let search =
      identity.last.map {
        expanded($0.rect, max(0.09, $0.rect.width * 0.9), max(0.08, $0.rect.height * 0.4))
      } ?? unit
    let candidates = try handOnly ? hands(image, unit) : bodies(image, region: search)
    if let target = identity.select(candidates, at: time) {
      let box = target.rect
      let region =
        !handOnly
        ? expanded(box, max(.zero, box.width * 0.25), box.height * 0.19)
        : (candidates.count == 1 ? unit : expanded(box, box.width * 0.5, box.height * 0.5))
      if handOnly {
        let side = fixedSide ?? target.side
        fixedSide = side
        frame.hands[side] = target.joints
      } else {
        frame.body = target.joints
        var detected = try hands(image, region)
        let first = assignHands(detected, to: target)
        for side in ["left", "right"] where first[side] == nil {
          if let w = target.joints[side + "Wrist"], w[2] >= 0.25 {
            let height = max(0.08, box.height * 0.48)
            let width = height * image.extent.height / image.extent.width
            let roi = CGRect(
              x: w[0] - width / 2, y: w[1] - height / 2, width: width, height: height
            ).intersection(unit)
            let extra = try hands(image, roi)
            for candidate in extra
            where !detected.contains(where: { distance($0.anchor, candidate.anchor) < 0.018 }) {
              detected.append(candidate)
            }
          }
        }
        frame.hands = assignHands(detected, to: target)
      }
      for (side,joints) in frame.hands {
        frame.handCrops[side] = try handCrop(image,joints,folder,frames.count,side)
      }
      let keys =
        handOnly
        ? ["middleMCP", "indexMCP", "ringMCP", "wrist", "thumbMP", "indexPIP"]
        : [
          "root", "neck", "leftHip", "rightHip", "leftShoulder", "rightShoulder", "leftKnee",
          "rightKnee",
        ]
      if let (file, rect) = try matte(
        image, region: region, person: !handOnly, votes: keys.compactMap { target.joints[$0] },
        folder: folder, index: frames.count)
      {
        frame.matte = file
        frame.rect = rect
      }
    }
    frames.append(frame)
  }
  var prior: CMSampleBuffer?
  while let s = src.copyNextSampleBuffer() {
    let pts = CMSampleBufferGetPresentationTimeStamp(s).seconds
    if pts <= start + 0.00001 {
      prior = s
      continue
    }
    if let p = prior {
      try autoreleasepool { try analyze(p) }
      prior = nil
    }
    try autoreleasepool { try analyze(s) }
  }
  if let p = prior { try analyze(p) }
  guard reader.status == .completed, !frames.isEmpty else {
    throw reader.error ?? fail("截取范围内没有视频帧")
  }
  guard frames.contains(where: { $0.matte != nil }) else { throw fail("未锁定该主体，请把起点选在手掌或躯干上") }
  let bytes = try JSONEncoder().encode(frames)
  try bytes.write(to: folder.appendingPathComponent("frames.json"))
  let meta: [String: Any] = [
    "size": size, "frames": frames.count, "withMask": frames.filter { $0.matte != nil }.count,
    "withBody": frames.filter { !$0.body.isEmpty }.count,
    "withHands": frames.filter { !$0.hands.isEmpty }.count, "sourceTrackStart": firstPTS,
  ]
  print(String(decoding: try JSONSerialization.data(withJSONObject: meta), as: UTF8.self))
}
do {
  if #available(macOS 14, *) { try run() } else { throw fail("主体跟踪需要 macOS 14 或更新版本") }
} catch {
  FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
  exit(1)
}
