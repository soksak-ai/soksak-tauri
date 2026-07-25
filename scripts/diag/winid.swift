import CoreGraphics
import Foundation
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in info {
    let owner = w["kCGWindowOwnerName"] as? String ?? "?"
    guard owner.contains("soksak") else { continue }
    let b = w["kCGWindowBounds"] as? [String: Any] ?? [:]
    let x = b["X"] as? Int ?? -1
    let wd = b["Width"] as? Int ?? 0
    let num = w["kCGWindowNumber"] as? Int ?? 0
    print("\(num):x=\(x):w=\(wd)")
}
