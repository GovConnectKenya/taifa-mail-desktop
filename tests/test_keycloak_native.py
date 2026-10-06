import importlib.util
from io import StringIO
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch


SCRIPT = Path(__file__).parents[1] / 'scripts' / 'keycloak-native.py'
SPEC = importlib.util.spec_from_file_location('keycloak_native', SCRIPT)
keycloak_native = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = keycloak_native
SPEC.loader.exec_module(keycloak_native)


class NativeFixtureNamingTests(unittest.TestCase):
    def test_provider_uses_scoped_test_database_name(self):
        with patch.object(keycloak_native.secrets, 'token_hex', return_value='a0b1c2d3e4f5'):
            provider = keycloak_native.NativeProvider(Path('.'), Path('.'), 'https://127.0.0.1', 12345, 'fixture-only')
        self.assertEqual(provider.database, 'identity_desktop_acceptance_a0b1c2d3e4f5_test')

    def test_record_database_accepts_only_scoped_test_name(self):
        with patch.object(keycloak_native.os, 'open', return_value=123), \
                patch.object(keycloak_native.os, 'fchmod'), \
                patch.object(keycloak_native.os, 'fdopen', return_value=StringIO()):
            keycloak_native.record_database('identity_desktop_acceptance_a0b1c2d3e4f5_test')

    def test_record_database_refuses_legacy_and_malformed_names_before_write(self):
        refused = (
            'desktop_identity_acceptance_a0b1c2d3e4f5',
            'identity_desktop_acceptance_nothexvalue_test',
            'identity_desktop_acceptance_a0b1c2d3e4f5',
            'identity_desktop_acceptance_a0b1c2d3e4f5_test_extra',
            'other_database',
        )
        with patch.object(keycloak_native.os, 'open') as open_file, \
                patch.object(keycloak_native.os, 'fchmod'), \
                patch.object(keycloak_native.os, 'fdopen', return_value=StringIO()):
            open_file.return_value = 123
            for database in refused:
                with self.subTest(database=database), self.assertRaises(RuntimeError):
                    keycloak_native.record_database(database)
            open_file.assert_not_called()

    def test_invalid_provider_name_fails_before_create_database(self):
        executed = []

        class SQL:
            @staticmethod
            def SQL(value):
                return value

            @staticmethod
            def Identifier(value):
                return value

        def execute(statement):
            executed.append(statement)
            raise RuntimeError('database creation reached')

        connection = types.SimpleNamespace(execute=execute)
        psycopg = types.ModuleType('psycopg')
        psycopg.sql = SQL
        psycopg.connect = MagicMock(return_value=connection)
        conninfo = types.ModuleType('psycopg.conninfo')
        conninfo.conninfo_to_dict = MagicMock(return_value={
            'host': '127.0.0.1', 'port': '60874', 'user': 'fixture', 'password': 'fixture'
        })
        with tempfile.TemporaryDirectory() as temporary:
            owner_file = Path(temporary) / 'owner.env'
            owner_file.write_text("TEST_OWNER_DSN='fixture-only'\n")
            owner_file.chmod(0o600)
            provider = keycloak_native.NativeProvider(Path(temporary), Path(temporary), 'https://127.0.0.1', 12345, 'fixture-only')
            provider.database = 'desktop_identity_acceptance_legacy'
            with patch.dict(sys.modules, {'psycopg': psycopg, 'psycopg.conninfo': conninfo}), \
                    patch.dict(keycloak_native.os.environ, {'DESKTOP_TEST_OWNER_ENV': str(owner_file)}), \
                    patch.object(keycloak_native, 'record_database'):
                with self.assertRaisesRegex(RuntimeError, 'fixture database name'):
                    provider.start()
        self.assertEqual(executed, [])
        psycopg.connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
