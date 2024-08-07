# This sample tests the matching of a traditional *args parameter
# and a *args unpacked Tuple to a *args TypeVarTuple.

from typing import Callable, TypeVar
from typing_extensions import TypeVarTuple  # pyright: ignore[reportMissingModuleSource]

Ts = TypeVarTuple("Ts")
R = TypeVar("R")


def call_with_params(func: Callable[[*Ts], R], *params: *Ts) -> R:
    # This should generate an error because it's missing a *.
    func(params)

    return func(*params)


def callback1(*args: int) -> int:
    ...


def callback2(*args: *tuple[int, int]) -> int:
    ...


call_with_params(callback1)
call_with_params(callback1, 1, 2, 3)

# This should generate an error.
call_with_params(callback1, "1")

# This should generate an error.
call_with_params(callback2)

call_with_params(callback2, 1, 1)

# This should generate an error.
call_with_params(callback2, 1, "")


def callback3(*args: *tuple[int, *tuple[str, ...], int]) -> int:
    ...


# This should generate an error.
call_with_params(callback3)

call_with_params(callback3, 1, 2)

call_with_params(callback3, 1, "hi", 2)

call_with_params(callback3, 1, "hi", "hi", 2)

# This should generate an error.
call_with_params(callback3, 1, 1, 2)


class Foo:
    @classmethod
    def foo(cls, *shape: *Ts) -> tuple[*Ts]:
        ...


def call_with_params2(target: Callable[[*Ts], int]) -> tuple[*Ts]:
    ...


def callback4(a: int, b: str, /) -> int:
    ...


def g(action: Callable[[int, str], int]):
    v1 = call_with_params2(callback4)
    reveal_type(v1, expected_text="tuple[int, str]")

    v2 = call_with_params2(action)
    reveal_type(v2, expected_text="tuple[int, str]")
