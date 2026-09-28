import AppKit
import Foundation
import ImageIO
import Vision

struct Box: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct TextObservation: Codable {
    let text: String
    let confidence: Float
    let box: Box
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: ConsortVision <image>\n".utf8))
    exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
      let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceThumbnailMaxPixelSize: 1920,
        kCGImageSourceCreateThumbnailWithTransform: true,
      ] as CFDictionary) else {
    FileHandle.standardError.write(Data("could not load image\n".utf8))
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .fast
request.usesLanguageCorrection = false
request.minimumTextHeight = 0.008
request.usesCPUOnly = true

do {
    try VNImageRequestHandler(cgImage: cgImage, orientation: .up).perform([request])
    let output = (request.results ?? []).compactMap { observation -> TextObservation? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let bounds = observation.boundingBox
        return TextObservation(
            text: candidate.string,
            confidence: candidate.confidence,
            box: Box(x: bounds.origin.x, y: bounds.origin.y, width: bounds.width, height: bounds.height)
        )
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    FileHandle.standardOutput.write(try encoder.encode(output))
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(4)
}
