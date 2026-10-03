"""Official-distribution fixture, with a retained private acceptance database."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import signal
import subprocess
import tarfile
import time
import urllib.request

VERSION = '26.8.0'
ARCHIVE_URL = f'https://github.com/keycloak/keycloak/releases/download/{VERSION}/keycloak-{VERSION}.tar.gz'
SHA256 = '9e41da899f838a58cd510fc98ed4f7cadc715aed5683e42aca20a0c9a2a3980a'
METADATA_URL = f'https://api.github.com/repos/keycloak/keycloak/releases/tags/{VERSION}'


def record_database(database):
    if not database.startswith('desktop_identity_acceptance_'):
        raise RuntimeError('Only this fixture database prefix can be recorded')
    path = Path('/tmp/desktop-workforce-retained-databases.jsonl')
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(json.dumps({'database': database, 'observed_at': datetime.now(timezone.utc).isoformat(), 'operator_cleanup_required': True}) + '\n')


class NativeProvider:
    def __init__(self, files, identity, base, port, admin_password):
        self.files, self.identity = files, identity
        self.base, self.port, self.admin_password = base, port, admin_password
        self.database = 'desktop_identity_acceptance_' + secrets.token_hex(6)
        self.process = self.connection = self.log = None
        self.created = False

    def start(self):
        import psycopg
        from psycopg import sql
        from psycopg.conninfo import conninfo_to_dict
        owner_file = Path(os.environ.get('DESKTOP_TEST_OWNER_ENV', '/tmp/taifa-identity-native-pg/owner.env'))
        if owner_file.stat().st_mode & 0o077:
            raise RuntimeError('Private owner configuration permissions required')
        values = {}
        for line in owner_file.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            key, value = line.removeprefix('export ').split('=', 1)
            parsed = shlex.split(value)
            if len(parsed) != 1:
                raise RuntimeError('Invalid private owner configuration')
            values[key.strip()] = parsed[0]
        dsn = values['TEST_OWNER_DSN']
        parameters = conninfo_to_dict(dsn)
        if parameters.get('host') != '127.0.0.1' or parameters.get('port') != '60874':
            raise RuntimeError('Only the approved isolated PostgreSQL fixture is allowed')
        self.connection = psycopg.connect(dsn, autocommit=True, connect_timeout=5)
        self.connection.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(self.database)))
        self.created = True
        record_database(self.database)
        print('Private acceptance database created; verifying official archive', flush=True)
        cache = Path('/tmp/taifa-desktop-official-26.8.0.tar.gz')
        archive = self.files / 'official-keycloak.tar.gz'
        valid_cache = False
        if cache.exists():
            if cache.is_symlink() or not cache.is_file() or cache.stat().st_uid != os.getuid():
                raise RuntimeError('Only an owned regular archive cache is permitted')
            with cache.open('rb') as source:
                valid_cache = hashlib.file_digest(source, 'sha256').hexdigest() == SHA256
            if valid_cache:
                shutil.copyfile(cache, archive)
        if not valid_cache:
            request = urllib.request.Request(METADATA_URL, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'taifa-desktop-disposable-acceptance'})
            with urllib.request.urlopen(request, timeout=30) as response:
                metadata = json.load(response)
            asset = next(row for row in metadata['assets'] if row['name'] == f'keycloak-{VERSION}.tar.gz')
            if asset.get('digest') != 'sha256:' + SHA256 or asset['browser_download_url'] != ARCHIVE_URL:
                raise RuntimeError('Official release metadata differs from reviewed pin')
            if not isinstance(asset.get('size'), int) or not 0 < asset['size'] < 200 * 1024 * 1024:
                raise RuntimeError('Official archive exceeds fixture size limit')
            deadline = time.monotonic() + 600
            with urllib.request.urlopen(ARCHIVE_URL, timeout=30) as response, archive.open('wb') as output:
                downloaded = 0
                while chunk := response.read(1024 * 1024):
                    if time.monotonic() > deadline:
                        raise RuntimeError('Official archive download deadline exceeded')
                    downloaded += len(chunk)
                    if downloaded > asset['size']:
                        raise RuntimeError('Official archive size exceeds release metadata')
                    output.write(chunk)
        with archive.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256')
        if digest.hexdigest() != SHA256:
            raise RuntimeError('Official archive checksum mismatch')
        if not valid_cache:
            shutil.copyfile(archive, cache)
            cache.chmod(0o600)
        with tarfile.open(archive) as package:
            package.extractall(self.files, filter='data')
        archive.unlink()
        home = self.files / f'keycloak-{VERSION}'
        theme = self.identity / 'keycloak/themes/taifa'
        if theme.is_dir():
            shutil.copytree(theme, home / 'themes/taifa')
        (home / 'data/import').mkdir(parents=True)
        shutil.copyfile(self.files / 'realm.json', home / 'data/import/realm.json')
        java_home = Path(os.environ.get('DESKTOP_TEST_JAVA_HOME', '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home'))
        if not (java_home / 'bin/java').is_file():
            raise RuntimeError('Process-local Java21 is required')
        version = subprocess.run([str(java_home / 'bin/java'), '-version'], capture_output=True, text=True, check=True, timeout=10)
        if 'version "21.' not in version.stderr:
            raise RuntimeError('Only process-local Java21 is approved')
        environment = {key: value for key, value in os.environ.items() if not key.startswith(('KC_', 'KCRAW_'))}
        environment.update({'JAVA_HOME': str(java_home), 'KC_DB': 'postgres', 'KC_DB_URL': f'jdbc:postgresql://127.0.0.1:60874/{self.database}', 'KC_DB_USERNAME': parameters['user'], 'KCRAW_DB_PASSWORD': parameters['password'], 'KC_BOOTSTRAP_ADMIN_USERNAME': 'disposable-operator', 'KC_BOOTSTRAP_ADMIN_PASSWORD': self.admin_password, 'JAVA_OPTS_APPEND': '-Xms128m -Xmx512m'})
        self.log = (self.files / 'provider-private.log').open('w')
        (self.files / 'provider-private.log').chmod(0o600)
        print('Official SHA256 verified; building isolated Java21 provider', flush=True)
        subprocess.run([str(home / 'bin/kc.sh'), 'build', '--db=postgres'], env=environment, stdout=self.log, stderr=subprocess.STDOUT, check=True, timeout=120)
        self.process = subprocess.Popen([str(home / 'bin/kc.sh'), 'start', '--optimized', '--import-realm', '--http-enabled=false', '--http-host=127.0.0.1', f'--https-port={self.port}', '--hostname=' + self.base, '--https-certificate-file=' + str(self.files / 'tls.crt'), '--https-certificate-key-file=' + str(self.files / 'tls.key'), '--truststore-paths=' + str(self.files / 'tls.crt'), '--cache=local', '--http-management-host=127.0.0.1', '--http-management-port=0'], env=environment, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)

    def close(self):
        if self.process is not None and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=5)
        if self.log:
            self.log.close()
            private_log = Path('/tmp/desktop-workforce-provider-private.log')
            shutil.copyfile(self.files / 'provider-private.log', private_log)
            private_log.chmod(0o600)
        if self.connection:
            self.connection.close()
        if self.created:
            print('Own provider stopped; private database retained for operator cleanup:', self.database, flush=True)
