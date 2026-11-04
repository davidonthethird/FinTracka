// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ReceiptRefiner",
    platforms: [.macOS(.v26)],
    products: [.executable(name: "fintracka-receipt-refiner", targets: ["ReceiptRefiner"])],
    targets: [.executableTarget(name: "ReceiptRefiner")]
)
