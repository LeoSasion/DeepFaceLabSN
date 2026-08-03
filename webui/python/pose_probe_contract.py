import hashlib


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def iter_probe_images(directory):
    return sorted(
        (
            path
            for path in directory.iterdir()
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        ),
        key=lambda path: (path.name.casefold(), path.name),
    )


def sha256_file(target):
    digest = hashlib.sha256()
    with target.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint_probe_directory(directory):
    digest = hashlib.sha256()
    file_digests = {}
    for target in iter_probe_images(directory):
        file_digest = sha256_file(target)
        file_digests[target.name] = file_digest
        digest.update(target.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_digest.encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest(), file_digests
