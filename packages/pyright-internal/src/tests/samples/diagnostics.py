# abstractMethodInvocation
from abc import ABC, abstractmethod
class Base(ABC):
    @abstractmethod
    def foo(self):
        ...
class Child(Base):
    pass
child = Child()
child.foo()  # calling abstract method not implemented

# annotatedMetadataInconsistent
from typing import Annotated
def func(x: Annotated[int, "meta"]):
    pass
func("text")  # metadata type is str but expected int

# annotatedParamCountMismatch
from typing import Annotated
T = Annotated[int, "meta1", "meta2"]  # two metadata but expected one

# annotatedTypeArgMissing
from typing import Annotated
T = Annotated  # missing type argument and annotation

# annotationBytesString
x: b"int"  # bytes literal in annotation

# annotationFormatString
y: f"{int}"  # f-string in type annotation

# annotationNotSupported
# for i: int in range(5): pass  # annotation not allowed for loop variable

# annotationRawString
z: r"MyType"  # raw string literal in annotation

# annotationSpansStrings
from __future__ import annotations
A: "List[" "int]"  # annotation split into two string literals

# annotationStringEscape
Value: "Line1\nLine2"  # newline escape in annotation

# argAssignment
def take_int(x: int):
    pass
take_int("text")  # Argument of type str not assignable to parameter of type int

# argAssignmentFunction
def square(n: int) -> int:
    return n * n
square("2")  # wrong type passed to function 'square'

# argAssignmentParam
def set_flag(flag: bool):
    pass
set_flag(1)  # 1 is int, not bool for parameter 'flag'

# argAssignmentParamFunction
def repeat(s: str, times: int):
    return s * times
repeat(5, "2")  # wrong types for parameters 's' and 'times' in function 'repeat'

# argMissingForParam
def func(a, b):
    pass
func(a=1)  # missing argument for parameter b

# argMissingForParams
def func2(x, y, z):
    pass
func2(x=1)  # missing arguments for parameters y and z

# argMorePositionalExpectedCount
def add(a, b, c):
    return a + b + c
add(1)  # expected 2 more positional arguments

# argMorePositionalExpectedOne
def square_one(x):
    return x * x
square_one()  # expected 1 more positional argument

# argPositional
def greet(name):
    print(f"Hello {name}")
greet(name="Alice")  # name must be given positionally

# argPositionalExpectedCount
def point(x, y):
    return (x, y)
point()  # expected 2 positional arguments

# argPositionalExpectedOne
def identity(x):
    return x
identity()  # expected 1 positional argument

# argTypePartiallyUnknown
from typing import Any
my_list = []  # type of elements unknown
def process(nums: list[int]):
    pass
process(my_list)  # argument type is partially unknown (list element type unknown)

# argTypeUnknown
def do_something(x):
    return x
do_something(5)
do_something("hello")  # argument type for untyped function is unknown

# assertAlwaysTrue
assert True  # this assert always evaluates to true

# assertTypeArgs
from typing import assert_type
assert_type(5)  # expects two arguments: (value, type)

# assertTypeTypeMismatch
from typing import assert_type
assert_type("hello", int)  # expected type int but got str

# assignmentExprComprehension
[j := j for j in range(5)]  # cannot reuse loop variable name as assignment target in comprehension

# assignmentExprContext
class C:
    x = 5
    # y = (x := 10)  # assignment expression not allowed in class body

# assignmentExprInSubscript
my_list = [0]
val = my_list[i := 0]  # assignment expression in subscript (Python 3.10+ only)

# assignmentInProtocol
from typing import Protocol
class Proto(Protocol):
    x = 0  # variables in Protocol must be declared, not assigned

# assignmentTargetExpr
# 1 + 2 = c  # cannot assign to an arithmetic expression

# asyncNotInAsyncFunction
async for x in [1, 2, 3]:
    print(x)  # 'async for' outside of async function

# awaitIllegal (requires Python 3.5+)
async def fetch():
    await some_coro()

# awaitNotAllowed
async def g():
    value: await int  # using 'await' in a type expression

# awaitNotInAsync
def regular_func():
    # await do_task()  # 'await' outside async function
    pass

# backticksIllegal
# x = `5`  # backticks (Python 2 repr) not allowed in Python 3

# baseClassCircular
class A(A):
    pass  # class cannot derive from itself

# baseClassFinal
from typing import final
@final
class FinalBase:
    pass
class SubClass(FinalBase):
    pass  # cannot subclass a final class

# baseClassIncompatible
class X: pass
class Y(X): pass
class Z(X, Y): pass  # X and Y are incompatible base classes (X is a base of Y)

# baseClassInvalid
def func3(): pass
class C(func3):
    pass  # func3 is not a class

# baseClassMethodTypeIncompatible
class Base1:
    def foo(self) -> int: ...
class Base2:
    def foo(self) -> str: ...
class Sub(Base1, Base2):
    def foo(self):
        return 0  # Base classes define foo with incompatible return types

# baseClassUnknown
from typing import Any
UnknownBase: Any = None
class Derived(UnknownBase):
    pass  # base class type UnknownBase is unknown

# baseClassVariableTypeIncompatible
class P:
    value: int
class Q:
    value: str
class R(P, Q):
    pass  # base classes define 'value' with incompatible types

# binaryOperationNotAllowed
X = int + str  # using binary '+' in a type expression

# bindParamMissing
class MyClass:
    def greet():  # missing 'self' parameter
        print("Hi")
MyClass().greet()

# bindTypeMismatch
class MyClass2:
    @classmethod
    def example(self):  # should use 'cls' instead of 'self'
        pass
MyClass2.example()

# breakInExceptionGroup
for i in [1]:
    try:
        1/0
    except* Exception:
        break  # 'break' not allowed in except* block

# breakOutsideLoop
# break  # 'break' outside of any loop

# bytesUnsupportedEscape
b"\z"  # unsupported escape sequence in bytes literal

# callableExtraArgs
from typing import Callable
f: Callable[[int], int, str]  # too many type arguments for Callable

# callableFirstArg
from typing import Callable
f2: Callable[int, str]  # first argument should be a list of types or '...'

# callableNotInstantiable
from typing import Callable
fn_type = Callable[[int], int]
result = fn_type()  # cannot instantiate a Callable type

# callableSecondArg
from typing import Callable
g: Callable[[int]]  # missing return type in Callable

# casePatternIsIrrefutable
match 5:
    case _:
        print("always matches")
    case 5:
        print("unreachable case")  # second case is irrefutable pattern not last

# classAlreadySpecialized
from typing import List
ListInt = List[int]
ListInt_of_str = ListInt[str]  # type already specialized

# classDecoratorTypeUnknown
def undecorated(cls):
    return cls
@undecorated
class MyClassDecor:
    x = 1  # class decorator has no type info, class type becomes unknown

# classDefinitionCycle
# class Acycle(Bcycle): pass
# class Bcycle(Acycle): pass  # classes depend on each other (cycle)

# classGetItemClsParam
class GenericClass:
    def __class_getitem__(self, item):
        return item  # should use 'cls' parameter

# classMethodClsParam
class MyCls:
    @classmethod
    def foo(self):
        pass  # first param should be 'cls'

# classNotRuntimeSubscriptable
class NormalClass: pass
t = NormalClass[int]  # will cause runtime error, not a valid subscript

# classPatternBuiltInArgPositional
match [1, 2]:
    case list(head=x, tail=y):
        print(x, y)  # built-in class pattern does not allow keyword sub-patterns

# classPatternPositionalArgCount
class Point:
    __match_args__ = ("x", "y")
    def __init__(self, x, y): self.x, self.y = x, y
p = Point(1, 2)
match p:
    case Point(a, b, c):
        print(a, b, c)  # too many positional patterns (expected 2)

# classPatternTypeAlias
from typing import List
MyListInt = List[int]
data = [1, 2]
match data:
    case MyListInt():
        print("Matched MyListInt alias")  # type alias cannot be used as pattern

# classPropertyDeprecated
class CProp:
    @classmethod
    @property
    def value(cls):
        return 5  # class property usage (deprecated)

# classTypeParametersIllegal
class MyClassT[T]:
    pass  # class type parameters require Python 3.12+

# classVarFirstArgMissing
from typing import ClassVar
class Demo:
    x: ClassVar  # missing type argument

# classVarNotAllowed
def func_local():
    x: ClassVar[int] = 0  # ClassVar not allowed in function scope

# classVarOverridesInstanceVar
# (example omitted or not applicable)

# classVarTooManyArgs
# (example omitted or not applicable)

# classVarWithTypeVar
# (example omitted or not applicable)

# clsSelfParamTypeMismatch
# (example omitted or not applicable)

# codeTooComplexToAnalyze
# (example omitted or not applicable)

# collectionAliasInstantiation
from typing import List
x_list = List()  # cannot instantiate a typing alias like List

# comparisonAlwaysFalse
if 5 == "5":
    pass  # always evaluates to False (int vs str have no overlap)

# comparisonAlwaysTrue
if 5 == 5:
    pass  # always evaluates to True

# comprehensionInDict
# { [x for x in range(3)]: 1 for y in range(1) }  # comprehension used as key (not allowed)

# comprehensionInSet
# { {x for x in range(3)} }  # comprehension used as element in set (not allowed)

# concatenateContext
# (example omitted or not applicable)

# concatenateParamSpecMissing
# (example omitted or not applicable)

# concatenateTypeArgsMissing
# (example omitted or not applicable)

# conditionalOperandInvalid
# if (lambda x: x): pass  # invalid conditional operand (not a bool)

# constantRedefinition
PI = 3.14
PI = "pie"  # redefined constant with different type

# constructorParametersMismatch
# (example omitted or not applicable)

# containmentAlwaysFalse
if 1 in ["x", "y"]:
    pass  # always False since list contains str, not int

# containmentAlwaysTrue
if "a" in "abc":
    pass  # always True since 'a' is definitely in 'abc'

# coroutineInConditionalExpression
async def coro1(): return 1
async def coro2(): return 2
result = coro1() if True else coro2()  # conditional yields coroutine (always truthy)

# dataClassBaseClassFrozen
# (example omitted or not applicable)

# dataClassFieldAndProperty
# (example omitted or not applicable)

# dataClassMutableDefault
# (example omitted or not applicable)

# dataClassOrderDefault
# (example omitted or not applicable)

# dunderClassSetting
class Dummy: pass
obj = Dummy()
obj.__class__ = int  # assigning to __class__ (not allowed)

# ellipsisInAssignment
x = ...  # Ellipsis used as value outside stub

# ellipsisInType
# X: ...  # Ellipsis used in type context (invalid)

# emptyTypeAlias
MyAlias = None  # empty type alias definition

# finalClassBaseClass
from typing import final
@final
class FinalCls: pass
# class SubFinal(FinalCls): pass  # cannot subclass a final class

# finalClassMethod
# (example omitted or not applicable)

# finalDecoratorUsedOnOverride
# (example omitted or not applicable)

# finalMethodOverride
# (example omitted or not applicable)

# finalOverwrite
# (example omitted or not applicable)

# functionAlreadyDefined
def funcA(): pass
# def funcA(): pass  # redefinition of function

# functionIsNeverCalled
def unused_func():
    print("Never called")
# (no call to unused_func)

# functionReturnsNever
def error_out():
    raise RuntimeError("Error")  # function never returns normally

# illegalTypeAnnotationTarget
# (1 + 1): int  # cannot annotate a non-variable expression

# importedSymbolIsUndefined
# from math import not_there  # importing undefined symbol

# inconsistentConstructor
# (example omitted or not applicable)

# inconsistentOverride
# (example omitted or not applicable)

# inconsistentReturnStatements
def maybe_value(flag: bool):
    if flag:
        return 1
    # else: missing return (inconsistent return paths)

# invalidDunderName
class D:
    def __notvalid__(self): pass  # invalid dunder name usage

# invalidEscapeSequence
s = "Hello\cWorld"  # invalid escape sequence '\c'

# invalidFunctionReturnType
def f_bad() -> 123:
    pass  # invalid return type annotation (not a type)

# invalidIdentifierChar
# (example omitted or not applicable)

# invalidIndexType
lst = [1, 2, 3]
val = lst["1"]  # invalid index type (str) for list

# invalidModuleName
# (example omitted or not applicable)

# invalidParameterName
# def func(**123): pass  # invalid parameter name

# invalidStubStatement
# (example omitted or not applicable)

# invalidTypeComment
# x = 5  # type int  (invalid type comment syntax)

# invalidTypeParamDefault
# (example omitted or not applicable)

# invalidTypeVar
# T = 5  # using TypeVar name for non-type (invalid)

# literalUnsupportedOperation
from typing import Literal
X_lit = Literal[5]
# Y = X_lit + 1  # unsupported operation on Literal

# metaclassConflict
class M1(type): pass
class M2(type): pass
class A_m(metaclass=M1): pass
class B_m(metaclass=M2): pass
# class C_m(A_m, B_m): pass  # metaclass conflict (M1 vs M2)

# moduleSpecializationNotSupported
# (example omitted or not applicable)

# namedParamAfterParamSpecArgs
# (example omitted or not applicable)

# namedTupleFirstArg
# (example omitted or not applicable)

# newTypeNameMismatch
from typing import NewType
MyInt = NewType('MyIntType', int)  # NewType name differs from variable name

# noCovariantOverride
# (example omitted or not applicable)

# overloadOnStubMismatch
# (example omitted or not applicable)

# paramNameMissingInOverride
class BaseX:
    def foo(self, x): pass
class SubX(BaseX):
    def foo(self, y): pass  # parameter name differs from base

# paramSpecArgsMissing
# (example omitted or not applicable)

# paramSpecKwargsMissing
# (example omitted or not applicable)

# paramSpecParamName
# (example omitted or not applicable)

# parameterAnnotationMissing
# (example omitted or not applicable)

# positionalOnlyInStub
# (example omitted or not applicable)

# printCall
print  # using 'print' as a statement (Python 3 requires parentheses)

# propertyInheritedSetAttr
# (example omitted or not applicable)

# propertyMissingType
# (example omitted or not applicable)

# protocolBaseClass
from typing import Protocol
class MyProto(Protocol): pass
class Impl(MyProto, int):
    pass  # Protocol class cannot derive from non-Protocol base

# protocolBaseClassWithTypeArgs
from typing import Protocol, Generic, TypeVar
T = TypeVar('T')
class ProtoEx(Generic[T], Protocol[T]):
    pass  # Protocol cannot use type arguments with new syntax

# protocolIllegal
from typing import Protocol  # Protocol requires Python 3.7+
class ProtoExample(Protocol):
    def foo(self): ...

# protocolNotAllowed
# (example omitted or not applicable)

# protocolTypeArgMustBeTypeParam
from typing import Protocol
class PEx(Protocol[int]):
    pass  # type arg for Protocol must be a type parameter

# protocolUnsafeOverlap
from typing import Protocol
class P1(Protocol): pass
class P2(Protocol): pass
class COverlap(P1, P2): pass  # overlapping Protocols (unsafe overlap)

# protocolVarianceContravariant
# (example omitted or not applicable)

# protocolVarianceCovariant
# (example omitted or not applicable)

# protocolVarianceInvariant
# (example omitted or not applicable)

# pyrightCommentInvalidDiagnosticBoolValue
# pyright: reportUnusedVariable=Truee  # invalid boolean value

# pyrightCommentInvalidDiagnosticSeverityValue
# pyright: reportUnusedVariable=medium  # invalid severity value

# pyrightCommentMissingDirective
# pyright:  # missing directive after pyright comment

# pyrightCommentNotOnOwnLine
x = 1  # pyright: ignore[reportUnusedVariable]  # not on its own line

# pyrightCommentUnknownDiagnosticRule
# pyright: reportUnknownRule=true  # unknown diagnostic rule

# pyrightCommentUnknownDiagnosticSeverityValue
# pyright: reportUnusedVariable=maybe  # invalid severity value

# pyrightCommentUnknownDirective
# pyright: unknown=true  # unknown pyright directive

# readOnlyArgCount
from typing import ReadOnly
x_readonly: ReadOnly[int, str]  # ReadOnly expects a single type argument

# relativeImportCycle
# (example omitted or not applicable)

# reportGeneralTypeIssues
# (example omitted or not applicable)

# returnInAsyncGenerator
async def agen():
    yield 1
    return 5  # cannot return value in async generator

# returnMissing
def compute(flag: bool) -> int:
    if flag:
        return 1
    # missing return on false path

# returnInExceptionGroup
def f_exc():
    try:
        1/0
    except* Exception:
        return 0  # 'return' not allowed in except* block

# returnOutsideFunction
# return 5  # cannot return outside a function

# shadowBuiltin
# (example omitted or not applicable)

# shadowImport
# (example omitted or not applicable)

# strictListInference
lst_unknown = []
val_unknown = lst_unknown[0]  # type of val is unknown (strict list inference)

# symbolNotExported
# (example omitted or not applicable)

# tooManyIndices
from typing import Tuple
t_tuple: Tuple[int, ...] = (1, 2)
x1, x2, x3 = t_tuple  # too many values to unpack (expected 2, got 3)

# tupleSizeMismatch
a, b, c = (1, 2)  # tuple size mismatch in unpacking

# typeAliasIllegalExpressionForm
if True:
    Alias = int  # defining type alias in a block (invalid form)

# typeAliasIsRecursiveDirect
from typing import List
TAlias = List['TAlias']  # recursive type alias referencing itself

# typeAliasStatementIllegal
type XAlias = int  # type alias statements require Python 3.12+

# typeAliasTypeBadScope
def func_alias():
    YAlias = int  # type alias inside function not allowed

# typeParameterBoundNotAllowed
# (example omitted or not applicable)

# typeParameterDuplicateName
from typing import TypeVar
T = TypeVar('T')
T = TypeVar('T')  # duplicate TypeVar name

# typeParameterNotUsed
U = TypeVar('U')
class Unused(Generic[U]):
    def __init__(self): 
        pass  # U is defined but not actually used

# typeParametersMissing
# (example omitted or not applicable)

# typeVarBoundViolation
TBound = TypeVar('TBound', bound=int)
def func_bound(x: TBound): ...
func_bound("hello")  # argument violates bound (str not a subtype of int)

# typeVarCovariantInheritance
# (example omitted or not applicable)

# typeVarInInvariantContext
# (example omitted or not applicable)

# typeVarNotUsed
# (example omitted or not applicable)

# typeVarTupleCannotSpecifyParams
# (example omitted or not applicable)

# typeVarTupleMustBeUnpacked
# (example omitted or not applicable)

# typeVarTupleNotAllowed
# (example omitted or not applicable)

# typeVarTupleNotAllowedInParamSpec
# (example omitted or not applicable)

# typeVarTupleUsageError
# (example omitted or not applicable)

# typeVarianceOverride
# (example omitted or not applicable)

# unknownArgument
def g_func(*, flag=False): pass
g_func(unknown=True)  # unknown keyword argument

# unknownParameter
def f_param(x): pass
f_param(y=5)  # 'y' is unknown parameter

# unknownImportSymbol
# from math import unknown  # symbol does not exist in module

# unknownMember
x_num = 10
x_num.unknown_attr  # int has no attribute 'unknown_attr'

# unknownMemberOfClass
class K:
    pass
K.missing_attr  # unknown class attribute

# unknownName
print(undefined_var)  # name not defined

# unknownPositionalArgument
def h(a): pass
h(1, 2)  # unknown extra positional argument

# untypedNamedTuple
# (example omitted or not applicable)

# untypedDataClassField
# (example omitted or not applicable)

# untypedDecorator
def my_decorator(func):
    return func
@my_decorator
def func2(x):
    return x  # decorator is untyped, type of func2 is unknown

# useBeforeDef
def test_use():
    print(val_use)
    val_use = 5  # using variable before assignment

# yieldInInit
class AInit:
    def __init__(self):
        yield 1  # 'yield' in __init__ (not allowed)

# yieldFromIllegal
def generator():
    yield from [1, 2, 3]  # 'yield from' requires Python 3.3+

# yieldFromOutsideAsync
def gen_func():
    yield from []  # 'yield from' not allowed outside async function

# yieldOutsideFunction
# yield 5  # 'yield' outside of a function or lambda

# yieldWithinComprehension
gen_expr = (yield x for x in range(5))  # 'yield' not allowed in comprehension

# zeroCaseStatementsFound
match 10:
    pass  # no case statements in match

# zeroLengthTupleNotAllowed
match value:
    case ():
        print("empty tuple pattern")  # zero-length tuple pattern not allowed
