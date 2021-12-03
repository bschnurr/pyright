# This sample tests the case where a function type is compared to another
# function type where one contains a positional-only marker and the
# other does not.

from typing import Protocol


class _Writer1(Protocol):
    def write(self, a: str, b: str) -> object:
        pass


class Writer1:
    def write(self, a: str, /, b: str):
        pass


def make_writer1(w: _Writer1):
    pass


# This should generate an error because the source function is positional-only.
make_writer1(Writer1())


class _Writer2(Protocol):
    def write(self, a: str, /, b: str) -> object:
        pass


class Writer2:
    def write(self, a: str, b: str):
        pass


def make_writer2(w: _Writer2):
    pass


make_writer2(Writer2())
