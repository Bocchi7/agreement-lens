#!/usr/bin/env python3

import argparse
import hashlib
import io
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from bs4 import BeautifulSoup


def slugify(url: str) -> str:
    parsed = urlparse(url)
    source = f"{parsed.netloc}{parsed.path}".strip("/") or "source"
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", source).strip("-")[:100]
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:10]
    return f"{slug}-{digest}"


def curl_command(url: str, raw_path: Path, headers_path: Path, insecure: bool = False) -> list[str]:
    command = [
        "curl",
        "--fail-with-body",
        "--location",
        "--compressed",
        "--retry",
        "3",
        "--retry-delay",
        "2",
        "--connect-timeout",
        "20",
        "--max-time",
        "120",
        "--user-agent",
        "Mozilla/5.0 (compatible; AgreementResearch/1.0)",
        "--dump-header",
        str(headers_path),
        "--output",
        str(raw_path),
    ]
    if insecure:
        command.append("--insecure")
    command.append(url)
    return command


def fetch(url: str, raw_path: Path, headers_path: Path) -> None:
    attempts = [curl_command(url, raw_path, headers_path)]
    if url.startswith("https://"):
        attempts.extend(
            [
                curl_command(
                    f"http://{url.removeprefix('https://')}", raw_path, headers_path
                ),
                curl_command(url, raw_path, headers_path, insecure=True),
            ]
        )
    last_error = None
    for command in attempts:
        try:
            subprocess.run(command, check=True)
            return
        except subprocess.CalledProcessError as error:
            last_error = error
    if last_error:
        raise last_error


def extract_pdf(raw: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(raw))
    return "\n\n".join(page.extract_text() or "" for page in reader.pages)


def extract_html(raw: bytes) -> str:
    soup = BeautifulSoup(raw, "lxml")
    if not soup.select_one("body") or len(soup.get_text(strip=True)) < 500:
        soup = BeautifulSoup(raw, "html.parser")
    for element in soup(["script", "style", "noscript", "svg", "template"]):
        element.decompose()
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    text = soup.get_text("\n", strip=True)
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    body = "\n".join(line for line in lines if line)
    return f"{title}\n\n{body}".strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="+")
    parser.add_argument("--out-dir", default="/tmp/agreement-research")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    failures = 0
    for url in args.urls:
        stem = slugify(url)
        raw_path = out_dir / f"{stem}.raw"
        headers_path = out_dir / f"{stem}.headers"
        text_path = out_dir / f"{stem}.txt"
        url_path = out_dir / f"{stem}.url"
        try:
            fetch(url, raw_path, headers_path)
            raw = raw_path.read_bytes()
            text = extract_pdf(raw) if raw.startswith(b"%PDF") else extract_html(raw)
            text_path.write_text(text, encoding="utf-8")
            url_path.write_text(f"{url}\n", encoding="utf-8")
            print(f"{url}\n  raw:  {raw_path}\n  text: {text_path}")
        except Exception as error:
            failures += 1
            print(f"ERROR {url}: {error}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
