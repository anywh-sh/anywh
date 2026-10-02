import SwiftRs
import Tauri
import UIKit
import WebKit

/// Cápsula de conexão nativa da Fase E (docs/23) — retirada (docs/24): o
/// indicador de conexão agora é renderizado pelo React dentro da
/// `MobileTopBar`, e a cápsula solta duplicava/sobrepunha esse texto sem
/// nenhum contexto de sessão. Mecanismo de `invoke`/`trigger` provado aqui
/// continua válido pra uma futura promoção nativa de verdade (docs/24
/// registra o porquê: precisa de botões separados + zona de blur, não uma
/// cápsula única) — plugin fica registrado, só sem nenhuma view por
/// enquanto.
///
/// `showContextMenu` (docs/33) é a segunda funcionalidade real do plugin:
/// menu de contexto nativo pro long-press em mensagens do chat (Copiar/
/// Editar), via `UIEditMenuInteraction` — a única API pública do UIKit que
/// permite apresentar um menu no estilo nativo (mesmo visual do menu de
/// seleção de texto do sistema) a partir de um ponto arbitrário, de forma
/// IMPERATIVA (`presentEditMenu(with:)`). `UIContextMenuInteraction`, a
/// alternativa mais óbvia, foi descartada de propósito: ela só dispara via
/// gesto PRÓPRIO do sistema (long-press automático anexado à view), sem
/// nenhum método público pra acionar a apresentação a partir de um long-press
/// já detectado em JS — o que é obrigatório aqui, já que o conteúdo é
/// WebView, não view nativa.
///
/// NÃO VALIDADO EM DISPOSITIVO REAL ainda — feito a partir da API pública
/// documentada da Apple (iOS 16+). Validar via o fluxo do Mac remoto
/// (docs/31) antes de considerar a Fase de menu nativo do docs/33 concluída:
/// posição do menu (o `sourcePoint` usa o espaço de coordenadas da própria
/// `WKWebView`, que deveria bater com `TouchEvent.clientX/clientY` do lado
/// JS, mas isso nunca foi confirmado contra o dispositivo real) e o caso de
/// descartar o menu sem escolher nada (`willDismissMenuFor`). Thread: todo
/// código que toca UIKit aqui salta pro `@MainActor` explicitamente
/// (`Task { @MainActor in }`/`MainActor.assumeIsolated`, nunca
/// `DispatchQueue.main.async` puro — mesmo achado da Fase E de docs/23 pra
/// este mesmo plugin, Swift 6 strict concurrency exige prova de isolamento
/// que o GCD sozinho não dá pro compilador). `@unchecked Sendable`: sem
/// isso, capturar `self`/`invoke` dentro do `Task { @MainActor in }` a
/// partir de um método `@objc` nonisolated (`load`/`showContextMenu`, que
/// podem em teoria ser chamados de qualquer thread pelo bridge do Tauri) dá
/// erro "sending risks causing data races" — mesma classe de erro, mesmo
/// fix já validado nesta classe antes (Fase E, docs/23).
class NativeChromePlugin: Plugin, UIEditMenuInteractionDelegate, @unchecked Sendable {
  private var editMenuInteraction: UIEditMenuInteraction?
  private var pendingItems: [ContextMenuItemArgs] = []
  private var pendingInvoke: Invoke?
  private var pendingResolved = false

  @objc public override func load(webview: WKWebView) {
    Task { @MainActor in
      let interaction = UIEditMenuInteraction(delegate: self)
      webview.addInteraction(interaction)
      self.editMenuInteraction = interaction

      // WKWebView's own outer `UIScrollView` (distinct from the DOM — every
      // `overflow: auto` div gets its own internal scroller under WebKit's
      // async scrolling, unaffected by this) auto-scrolls the whole page to
      // bring a focused input above the keyboard. `body { position: fixed }`
      // (index.css) only stops the DOM's own scroll machinery, not this
      // native one — so it never covered the case reported here: opening the
      // keyboard on a screen with no scrollable content at all (a fresh "new
      // conversation" tab) still panned the page, hiding the fixed/absolute
      // header (MobileTopBar) since it's positioned against the layout
      // viewport, not wherever this native scroll happened to land it. The
      // app never relies on this outer scroll view for anything real — every
      // actual scroll surface (MessageLog, the composer's ProseMirror) is an
      // inner DOM scroller — so disabling it outright removes the
      // auto-scroll-into-view behavior without losing any real scrolling.
      webview.scrollView.isScrollEnabled = false
      webview.scrollView.bounces = false
    }
  }

  @objc func showContextMenu(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShowContextMenuArgs.self)
    // `Task { @MainActor in }`, não `DispatchQueue.main.async` puro — mesmo
    // achado já documentado na Fase E (docs/23) pra este mesmo plugin: GCD
    // salta pra main thread em runtime, mas o compilador (Swift 6 strict
    // concurrency) não consegue provar isolamento a partir disso, e
    // `UIEditMenuInteraction.presentEditMenu`/`UIMenu`/`UIAction` são
    // `@MainActor`-isolados de verdade no SDK.
    Task { @MainActor in
      // Um menu já pendente (long-press duplo antes do primeiro resolver) —
      // resolve ele como descartado antes de abrir o novo, pra nunca deixar
      // uma promise de JS pendurada pra sempre.
      self.resolvePending(with: nil)

      guard let interaction = self.editMenuInteraction else {
        invoke.resolve(ShowContextMenuResult(selectedId: nil))
        return
      }
      self.pendingItems = args.items
      self.pendingInvoke = invoke
      self.pendingResolved = false
      let point = CGPoint(x: args.point.x, y: args.point.y)
      // `identifier` não tem default nesse SDK apesar do que a doc pública
      // sugere (`init(identifier:sourcePoint:)`, sempre os dois argumentos)
      // — `nil` é o valor correto quando não precisamos rastrear/comparar
      // configurações entre chamadas.
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      interaction.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
    }
  }

  private func resolvePending(with selectedId: String?) {
    guard !pendingResolved, let invoke = pendingInvoke else { return }
    pendingResolved = true
    pendingInvoke = nil
    invoke.resolve(ShowContextMenuResult(selectedId: selectedId))
  }

  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction,
    menuFor configuration: UIEditMenuConfiguration,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    // Chamado pelo UIKit síncrono (não dá pra virar `async`/`Task` aqui, o
    // retorno precisa ser imediato) — `assumeIsolated` só afirma pro
    // compilador o que já é verdade em runtime: todo delegate de
    // `UIEditMenuInteraction` roda na main thread, mesmo contrato de
    // qualquer UIInteraction do UIKit.
    MainActor.assumeIsolated {
      let actions: [UIMenuElement] = pendingItems.map { item in
        var attributes: UIMenuElement.Attributes = []
        if item.disabled { attributes.insert(.disabled) }
        let action = UIAction(
          title: item.label,
          image: item.systemIcon.flatMap { UIImage(systemName: $0) },
          attributes: attributes,
          handler: { [weak self] _ in self?.resolvePending(with: item.id) }
        )
        if let reason = item.disabledReason {
          action.subtitle = reason
        }
        return action
      }
      return UIMenu(children: actions)
    }
  }

  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction,
    willDismissMenuFor configuration: UIEditMenuConfiguration,
    animator: (any UIEditMenuInteractionAnimating)?
  ) {
    // Fechou sem escolher nada (toque fora, swipe, Escape em teclado externo)
    // — se uma ação já tiver resolvido isso (`resolvePending` é idempotente
    // via `pendingResolved`), este chamado não faz nada.
    resolvePending(with: nil)
  }
}

/// `Invoke` (pacote `Tauri`, não nosso) também é capturado dentro do
/// `Task { @MainActor in }` de `showContextMenu` — mesmo raciocínio do
/// `@unchecked Sendable` da classe acima, só que via extensão retroativa
/// porque não é um tipo que definimos aqui.
extension Invoke: @unchecked Sendable {}

private struct ContextMenuItemArgs: Decodable {
  let id: String
  let label: String
  let systemIcon: String?
  let disabled: Bool
  let disabledReason: String?
}

private struct ContextMenuPointArgs: Decodable {
  let x: Double
  let y: Double
}

private struct ShowContextMenuArgs: Decodable {
  let items: [ContextMenuItemArgs]
  let point: ContextMenuPointArgs
}

private struct ShowContextMenuResult: Encodable {
  let selectedId: String?
}

@_cdecl("init_plugin_native_chrome")
func initPlugin() -> Plugin {
  return NativeChromePlugin()
}
