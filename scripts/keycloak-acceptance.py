#!/usr/bin/env python3
"""Disposable real Keycloak acceptance for the reviewed public desktop profile."""
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True


def run(*args, **kwargs):
    kwargs.setdefault("timeout", 30)
    return subprocess.run(*args, **kwargs)

def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def main():
    desktop = Path(__file__).resolve().parents[1]
    identity = Path(os.environ.get('IDENTITY_PROJECT_ROOT', str(desktop.parent / 'taifa-identity'))).resolve()
    sys.path.insert(0, str(identity / 'services' / 'management'))
    from identity.keycloak_admin import KeycloakAdmin
    from identity.native_clients import registration, SCOPES
    name = 'taifa-desktop-acceptance-' + secrets.token_hex(4)
    database, network = name + '-db', name + '-net'
    port, logout_port = free_port(), free_port()
    base = f'https://localhost:{port}'
    issuer = base + '/realms/taifa-staff-dev'
    passwords = {key: secrets.token_urlsafe(32) for key in ('admin', 'user', 'db')}
    native = os.environ.get('DESKTOP_KEYCLOAK_NATIVE') == '1'
    provider = None
    image = os.environ.get('IDENTITY_TEST_IMAGE', 'taifa-identity-keycloak:review')
    postgres = (identity / 'infra' / 'postgres-image.lock').read_text().strip()
    with tempfile.TemporaryDirectory(prefix='taifa-desktop-provider-') as directory:
        files = Path(directory)
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1', '-keyout', str(files / 'tls.key'), '-out', str(files / 'tls.crt')], check=True, capture_output=True)
        realm = json.loads((identity / 'keycloak' / 'realms' / 'taifa-staff-dev.json').read_text())
        # Genuine LoA arises only after required password and OTP executions.
        # No hardcoded protocol mapper claims that a password is MFA.
        realm.setdefault('attributes', {})['acr.loa.map'] = json.dumps({'taifa-password': 1, 'taifa-mfa': 2, 'taifa-phishing-resistant': 3})
        realm['browserFlow'] = 'desktop-disposable-browser'
        realm['authenticatorConfig'] = [
            {'alias': 'desktop-loa-1', 'config': {'loa-condition-level': '1', 'loa-max-age': '300'}},
            {'alias': 'desktop-loa-2', 'config': {'loa-condition-level': '2', 'loa-max-age': '300'}},
        ]
        def execution(authenticator, priority, configuration=None):
            row = {'authenticator': authenticator, 'authenticatorFlow': False, 'requirement': 'REQUIRED', 'priority': priority, 'userSetupAllowed': False}
            if configuration:
                row['authenticatorConfig'] = configuration
            return row
        def subflow(alias, requirement, priority):
            return {'flowAlias': alias, 'authenticatorFlow': True, 'requirement': requirement, 'priority': priority, 'userSetupAllowed': False}
        def flow(alias, executions, top=False):
            return {'alias': alias, 'providerId': 'basic-flow', 'topLevel': top, 'builtIn': False, 'authenticationExecutions': executions}
        cookie = execution('auth-cookie', 0)
        cookie['requirement'] = 'ALTERNATIVE'
        realm['authenticationFlows'] = [
            flow('desktop-disposable-browser', [cookie, subflow('desktop-disposable-forms', 'ALTERNATIVE', 10)], True),
            flow('desktop-disposable-forms', [subflow('desktop-level-1', 'CONDITIONAL', 0), subflow('desktop-level-2', 'CONDITIONAL', 10)]),
            flow('desktop-level-1', [execution('conditional-level-of-authentication', 0, 'desktop-loa-1'), execution('auth-username-password-form', 10)]),
            flow('desktop-level-2', [execution('conditional-level-of-authentication', 0, 'desktop-loa-2'), execution('auth-otp-form', 10)]),
        ]
        (files / 'realm.json').write_text(json.dumps(realm))
        for file in files.iterdir():
            file.chmod(0o600 if native and file.name == 'tls.key' else 0o644)
        files.chmod(0o700 if native else 0o755)
        context = ssl.create_default_context(cafile=str(files / 'tls.crt'))
        def request(path, body=None, token=None, method=None, timeout=10):
            headers = {}
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
                headers['Content-Type'] = 'application/json'
            if token:
                headers['Authorization'] = 'Bearer ' + token
            req = urllib.request.Request(base + path, data=body, headers=headers, method=method)
            with urllib.request.urlopen(req, context=context, timeout=timeout) as response:
                content = response.read()
                return json.loads(content) if content else None
        try:
            if native:
                import importlib.util
                module_spec = importlib.util.spec_from_file_location('desktop_native_provider', desktop / 'scripts/keycloak-native.py')
                module = importlib.util.module_from_spec(module_spec)
                module_spec.loader.exec_module(module)
                provider = module.NativeProvider(files, identity, base, port, passwords['admin'])
                files.chmod(0o700)
                (files / 'tls.key').chmod(0o600)
                provider.start()
            else:
                print('Starting isolated PostgreSQL and Keycloak26.8', flush=True)
                run(['docker', 'network', 'create', network], check=True, capture_output=True)
                run(['docker', 'run', '-d', '--name', database, '--network', network, '-e', 'POSTGRES_DB=keycloak', '-e', 'POSTGRES_USER=keycloak', '-e', 'POSTGRES_PASSWORD=' + passwords['db'], postgres], check=True, capture_output=True)
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if run(['docker', 'exec', database, 'pg_isready', '-U', 'keycloak'], capture_output=True).returncode == 0:
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError('Disposable database unavailable')
                run(['docker', 'run', '-d', '--name', name, '--network', network, '-p', f'127.0.0.1:{port}:8443', '-v', f'{files}:/run/acceptance:ro', '-v', f'{files / "realm.json"}:/opt/keycloak/data/import/realm.json:ro', '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=disposable-operator', '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD=' + passwords['admin'], '-e', 'KC_DB=postgres', '-e', f'KC_DB_URL=jdbc:postgresql://{database}:5432/keycloak', '-e', 'KC_DB_USERNAME=keycloak', '-e', 'KC_DB_PASSWORD=' + passwords['db'], image, 'start', '--optimized', '--import-realm', '--http-enabled=false', '--hostname=' + base, '--https-certificate-file=/run/acceptance/tls.crt', '--https-certificate-key-file=/run/acceptance/tls.key', '--truststore-paths=/run/acceptance/tls.crt'], check=True, capture_output=True)
            deadline = time.monotonic() + 360
            while time.monotonic() < deadline:
                if native and provider.process.poll() is not None:
                    raise RuntimeError('Private provider exited during startup')
                try:
                    request('/realms/taifa-staff-dev/.well-known/openid-configuration', timeout=5)
                    break
                except Exception:
                    time.sleep(1)
            else:
                logs = run(['docker', 'logs', '--tail', '25', name], capture_output=True, text=True) if not native else None
                # Emit lifecycle errors only, never credentials or token responses.
                print('Provider startup failed; log lines:', len(logs.stdout.splitlines()) + len(logs.stderr.splitlines()) if logs else 'private native log retained only during fixture')
                raise RuntimeError('Disposable provider unavailable')
            print('Disposable HTTPS realm ready; applying reviewed desktop registration', flush=True)
            authorization = request('/realms/master/protocol/openid-connect/token', urllib.parse.urlencode({'client_id': 'admin-cli', 'grant_type': 'password', 'username': 'disposable-operator', 'password': passwords['admin']}).encode())
            admin_token = authorization['access_token']
            admin_path = '/admin/realms/taifa-staff-dev'
            os.environ.update({'OIDC_ISSUER': issuer, 'MAIL_NATIVE_PROJECT_ID': 'disposable-mail-project', 'MAIL_NATIVE_ENVIRONMENT': 'development', 'MAIL_NATIVE_API_AUDIENCE': 'disposable-mail-api', 'MAIL_NATIVE_BACKCHANNEL_LOGOUT_URL': f'https://{"localhost" if native else "host.docker.internal"}:{logout_port}/backchannel'})
            spec = registration('disposable-mail-project', 'disposable-desktop-environment', 'development', 'native-mail-desktop', ['ke.govconnect.taifamail.auth:/oauth2redirect'], SCOPES, issuer)
            # Exercise the reviewed registration adapter against actual REST.
            # Only this disposable fixture uses the bootstrapped operator token;
            # it does not claim production service credential/governance proof.
            adapter = KeycloakAdmin.__new__(KeycloakAdmin)
            adapter.issuer = issuer
            registration_observations = []
            def adapter_request(method, path, body=None):
                result = request(admin_path + path, body, admin_token, method)
                if method == 'GET':
                    # Public client and scope configuration only, never token,
                    # user or credential endpoints. Private diagnostics allow
                    # comparison against the actual pinned provider.
                    registration_observations.append({'path': path, 'response': result})
                    diagnostic = Path('/tmp/desktop-workforce-provider-registration.json')
                    descriptor = os.open(diagnostic, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                    os.fchmod(descriptor, 0o600)
                    with os.fdopen(descriptor, 'w') as output:
                        json.dump(registration_observations, output)
                return result
            adapter.request = adapter_request
            adapter.register_native_mail_client(spec)
            adapter.register_native_mail_client(spec, verify_only=True)
            request(admin_path + '/users', {'username': 'disposable-desktop-user', 'enabled': True, 'emailVerified': True, 'email': 'desktop-acceptance@example.test', 'requiredActions': ['CONFIGURE_TOTP'], 'credentials': [{'type': 'password', 'value': passwords['user'], 'temporary': False}]}, admin_token)
            environment = {**os.environ, 'NODE_EXTRA_CA_CERTS': str(files / 'tls.crt'), 'IDENTITY_PROJECT_ROOT': str(identity), 'ACCEPTANCE_ISSUER': issuer, 'ACCEPTANCE_USERNAME': 'disposable-desktop-user', 'ACCEPTANCE_PASSWORD': passwords['user'], 'ACCEPTANCE_TLS_CERT': str(files / 'tls.crt'), 'ACCEPTANCE_TLS_KEY': str(files / 'tls.key'), 'ACCEPTANCE_BACKCHANNEL_PORT': str(logout_port), 'ACCEPTANCE_BACKCHANNEL_HOST': '127.0.0.1' if native else '0.0.0.0'}
            print('Reviewed registration verified; starting real browser MFA checks', flush=True)
            run(['node', str(desktop / 'scripts' / 'keycloak-acceptance.mjs')], cwd=desktop, env=environment, check=True, timeout=660 if os.environ.get('DESKTOP_MAIL_PROOF_FILE') else 240)
        finally:
            if native:
                if provider:
                    provider.close()
            else:
                for container in (name, database):
                    try:
                        run(['docker', 'rm', '-f', '-v', container], capture_output=True, timeout=10)
                    except subprocess.TimeoutExpired:
                        print('Disposable container cleanup unconfirmed:', container)
                try:
                    run(['docker', 'network', 'rm', network], capture_output=True, timeout=10)
                except subprocess.TimeoutExpired:
                    print('Disposable network cleanup unconfirmed:', network)



if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAIL disposable desktop Keycloak acceptance:', type(error).__name__, file=sys.stderr)
        if type(error).__name__ == 'KeycloakUnavailable':
            print(str(error), file=sys.stderr)
        sys.exit(1)
