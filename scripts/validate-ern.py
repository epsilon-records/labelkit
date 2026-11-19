#!/usr/bin/env python3
"""Validate generated fictional fixtures against checksum-pinned official DDEX XSDs.

Downloads only the two locked HTTPS schema URLs, outside the checkout. XML and XSD
validation then run offline. No schema, audio or real catalogue data is vendored.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

REPO = Path(__file__).resolve().parent.parent


def validate(schema: Path, xml: Path):
    raw = xml.read_bytes()
    if re.search(br"<!\s*(DOCTYPE|ENTITY)\b", raw, re.I):
        raise ValueError("Fixture XML must not contain a DTD or entity declaration")
    return subprocess.run(
        ["xmllint", "--nonet", "--noout", "--schema", str(schema), str(xml)],
        capture_output=True, text=True, timeout=30, check=False,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xml-dir", required=True, type=Path)
    parser.add_argument("--schema-dir", required=True, type=Path)
    args = parser.parse_args()
    xml_dir, schema_dir = args.xml_dir.resolve(), args.schema_dir.resolve()
    if xml_dir.is_relative_to(REPO) or schema_dir.is_relative_to(REPO):
        raise ValueError("Keep generated XML and downloaded XSDs outside the checkout")
    schema_dir.mkdir(parents=True, exist_ok=True)
    lock = json.loads((REPO / "docs/ddex/schema-lock.json").read_text())
    for entry in lock["files"]:
        if not entry["url"].startswith("https://service.ddex.net/xml/") or Path(entry["name"]).name != entry["name"]:
            raise ValueError("Unexpected locked schema source")
        path = schema_dir / entry["name"]
        subprocess.run([
            "curl", "--fail", "--silent", "--show-error", "--location", "--max-redirs", "5",
            "--proto", "=https", "--proto-redir", "=https", "--max-time", "60",
            entry["url"], "--output", str(path),
        ], check=True, timeout=65)
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"Schema checksum changed: {entry['name']}; review the lock, do not accept moving latest")
    original = (schema_dir / "release-notification.xsd").read_text()
    online_import = 'schemaLocation="http://ddex.net/xml/allowed-value-sets/allowed-value-sets.xsd"'
    if original.count(online_import) != 1:
        raise ValueError("Unexpected schema import; refusing an unpinned dependency")
    schema = schema_dir / "release-notification-offline.xsd"
    schema.write_text(original.replace(online_import, 'schemaLocation="allowed-value-sets.xsd"'))
    files = sorted(xml_dir.glob("*.xml"))
    if not files:
        raise ValueError("No generated XML fixtures; validation must not pass vacuously")
    for path in files:
        result = validate(schema, path)
        if result.returncode:
            raise ValueError(f"Fixture failed official XSD validation: {path.name}\n{result.stderr}")
    # Prove both required-field checking and the locked AVS import are active.
    with tempfile.TemporaryDirectory(prefix="ern-invalid-", dir=schema_dir) as temp:
        source = files[0].read_text()
        missing, removed = re.subn(r"<MessageHeader>.*?</MessageHeader>", "", source, count=1, flags=re.S)
        bad_avs, replaced = re.subn(r"(<ReleaseType>)[^<]+(</ReleaseType>)", r"\1INVALID_TEST_RELEASE_TYPE\2", source, count=1)
        if removed != 1 or replaced != 1:
            raise ValueError("Negative-control fixture has unexpected structure")
        for name, body in [("missing-header.xml", missing), ("invalid-avs.xml", bad_avs)]:
            path = Path(temp) / name
            path.write_text(body)
            if validate(schema, path).returncode == 0:
                raise ValueError(f"Schema validation accepted the negative control: {name}")
    print(f"ERN {lock['ern_version']} / AVS {lock['avs_version']}: {len(files)} generated fixtures validate; required-field and AVS negative controls rejected. No XML network access.")


if __name__ == "__main__":
    main()
