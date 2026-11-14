import SwiftUI

struct SignInView: View {
    @Bindable var model: SignInModel
    var app: AppModel
    var offline: Bool = false
    var banner: String?
    @FocusState private var focus: Field?
    enum Field { case address, password, code }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: Space.s6) {
                VStack(spacing: Space.s2) {
                    Icon(.mail, size: 40).foregroundStyle(Theme.accentFg)
                    Text("Taifa Mail").taifa(.hero).foregroundStyle(Theme.text)
                    Text(subtitle).taifa(.body).foregroundStyle(Theme.text3).multilineTextAlignment(.center)
                }
                VStack(alignment: .leading, spacing: Space.s3) {
                    if let banner { Banner(kind: .warn, icon: .info, message: banner) }
                    if offline { Banner(kind: .warn, icon: .wifi, message: "You are offline. Connect to sign in.") }
                    if let e = model.error { Banner(kind: .danger, icon: .danger, message: e) }
                    if let i = model.info { Banner(kind: .info, icon: .info, message: i) }
                    content
                }
                .frame(width: 352)
                Text("Passkey sign-in is not available in this version.").taifa(.meta).foregroundStyle(Theme.text3)
            }
            .padding(Space.s6)
            .frame(width: 400)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
        }
        .onAppear { focus = model.address.isEmpty ? .address : .password }
    }

    private var subtitle: String {
        switch model.step {
        case .password: "Sign in to your government mailbox"
        case .codeAddress: "Get a one time sign-in code"
        case .codeEntry: "Enter the code we emailed you"
        case .secondFactor: "Verify it is you"
        }
    }

    @ViewBuilder private var content: some View {
        switch model.step {
        case .password:
            fieldLabel("Mailbox address")
            TextField("name@example.go.ke", text: $model.address)
                .textFieldStyle(FieldStyle()).font(.taifaMono(13)).focused($focus, equals: .address)
                .textContentType(.username).autocorrectionDisabled()
                .accessibilityIdentifier("signin-address")
            fieldLabel("Password")
            SecureField("Password", text: $model.password)
                .textFieldStyle(FieldStyle()).focused($focus, equals: .password)
                .accessibilityIdentifier("signin-password")
                .onSubmit { Task { await app.signInWithPassword() } }
            Button { Task { await app.signInWithPassword() } } label: { buttonLabel("Sign in") }
                .buttonStyle(PrimaryButtonStyle(full: true))
                .disabled(model.busy || offline || model.address.isEmpty || model.password.isEmpty)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("signin-submit")
            Button("Email me a sign-in code") { model.step = .codeAddress; model.error = nil }
                .buttonStyle(QuietButtonStyle()).frame(maxWidth: .infinity)
        case .codeAddress:
            fieldLabel("Mailbox address")
            TextField("name@example.go.ke", text: $model.address).textFieldStyle(FieldStyle()).font(.taifaMono(13))
            Button { Task { await app.requestCode() } } label: { buttonLabel("Send code") }
                .buttonStyle(PrimaryButtonStyle(full: true)).disabled(model.busy || offline || model.address.isEmpty)
            backLink
        case .codeEntry:
            fieldLabel("6 digit code")
            TextField("123456", text: $model.code).textFieldStyle(FieldStyle()).font(.taifaMono(16)).focused($focus, equals: .code)
                .onSubmit { Task { await app.verifyCode() } }
            Button { Task { await app.verifyCode() } } label: { buttonLabel("Verify") }
                .buttonStyle(PrimaryButtonStyle(full: true)).disabled(model.busy || model.code.count < 6)
            backLink
        case .secondFactor:
            fieldLabel("Verification code")
            TextField("Authenticator, emailed or recovery code", text: $model.code).textFieldStyle(FieldStyle()).font(.taifaMono(14)).focused($focus, equals: .code)
                .accessibilityIdentifier("signin-code")
                .onSubmit { Task { await app.verifySecondFactor() } }
            Button { Task { await app.verifySecondFactor() } } label: { buttonLabel("Verify") }
                .buttonStyle(PrimaryButtonStyle(full: true)).disabled(model.busy || model.code.isEmpty)
            Button("Email me a code") { Task { await app.emailSecondFactor() } }
                .buttonStyle(QuietButtonStyle()).frame(maxWidth: .infinity).disabled(model.busy)
            backLink
        }
    }

    private var backLink: some View {
        HStack(spacing: Space.s1) {
            Button { model.reset() } label: { HStack(spacing: Space.s1) { Icon(.chevronLeft, size: 12); Text("Back to sign in") } }
                .buttonStyle(QuietButtonStyle())
        }.frame(maxWidth: .infinity)
    }

    private func fieldLabel(_ s: String) -> some View { Text(s).taifa(.meta).foregroundStyle(Theme.text2) }

    private func buttonLabel(_ s: String) -> some View {
        HStack(spacing: Space.s2) {
            if model.busy { ProgressView().controlSize(.small).tint(.white) }
            Text(model.busy ? "Please wait" : s)
        }.frame(maxWidth: .infinity)
    }
}
