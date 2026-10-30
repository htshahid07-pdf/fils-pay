# Exact-match, line-ending-aware file editor the AI used for every change in this repo.
# The repo uses CRLF line endings; rep() converts the snippet to match and asserts the
# old text occurs exactly `count` times, so an edit can never land in the wrong place.
import sys
def rep(path, old, new, count=1):
    b = open(path,'rb').read().decode()
    crlf = '\r\n' in b
    if crlf:
        old = old.replace('\r\n','\n').replace('\n','\r\n'); new = new.replace('\r\n','\n').replace('\n','\r\n')
    n = b.count(old)
    assert n == count, f"{path}: expected {count} match(es), found {n}:\n{old[:200]}"
    b = b.replace(old, new)
    open(path,'wb').write(b.encode())
    print("edited", path)
def write(path, text, crlf=True):
    open(path,'wb').write((text.replace('\n','\r\n') if crlf else text).encode()); print("wrote", path)
