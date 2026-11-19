internal import Expo
import UIKit

@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  private var privacyCovers: [UIView] = []

  override func sceneWillResignActive(_ scene: UIScene) {
    if let windowScene = scene as? UIWindowScene {
      for window in windowScene.windows {
        let cover = UIView(frame: window.bounds)
        cover.backgroundColor = UIColor(red: 0.078, green: 0.074, blue: 0.094, alpha: 1)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(cover)
        privacyCovers.append(cover)
      }
    }
    super.sceneWillResignActive(scene)
  }

  override func sceneDidBecomeActive(_ scene: UIScene) {
    super.sceneDidBecomeActive(scene)
    privacyCovers.forEach { $0.removeFromSuperview() }
    privacyCovers.removeAll()
  }
}
