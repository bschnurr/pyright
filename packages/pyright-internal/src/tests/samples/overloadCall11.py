# This sample tests overload calls where an overload-discriminating
# argument comes from an unannotated parameter.

from typing import Literal, overload


@overload
def func1(value: int, *, mode: Literal["int"]) -> int: ...


@overload
def func1(value: int, *, mode: Literal["str"]) -> str: ...


def func1(value: int, *, mode: str) -> int | str:
    return value if mode == "int" else str(value)


def func2(mode):
    result = func1(1, mode=mode)
    reveal_type(result, expected_text="Unknown")


def func3():
    reveal_type(func1(1, mode="int"), expected_text="int")
    reveal_type(func1(1, mode="str"), expected_text="str")
