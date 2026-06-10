# Sparse Resolver Test Examples

These examples describe sample files that should be added as analyzer tests once the sparse resolver is wired into the binder. The current prototype unit tests cover the decision layer directly. These examples are intended for integration and differential testing.

## Test Matrix

| Case | Export surface | Expected sparse decision | Behavior expectation |
| --- | --- | --- | --- |
| Static `__all__`, present name | Complete | Positive candidate, then trusted resolver or fallback | Same type as baseline |
| Static `__all__`, missing name | Complete | `notFound` | Same missing-name diagnostic as baseline |
| Dynamic `__all__` | Unknown | `fallback: dynamicAll` | Same as baseline |
| No `__all__`, normal symbols | Partial | Present names may be candidates, absence must fallback | Same as baseline |
| Re-export chain | Partial or complete depending metadata | Fallback until per-name re-export is proven | Same as baseline |
| Conditional import | Partial or unknown | Fallback | Same as baseline |
| Namespace package | Partial | Fallback on absence | Same as baseline |
| Stub with static exports | Complete if proven | Safe negative result | Same as baseline |

## Example 1: Static `__all__`, Present Name

### `lib_static_all.py`

```py
__all__ = ["A", "make_a"]

class A:
    def method(self) -> int:
        return 1

class Hidden:
    pass

def make_a() -> A:
    return A()
```

### `app.py`

```py
from lib_static_all import *

reveal_type(A)       # expected: type[A]
reveal_type(make_a)  # expected: () -> A
reveal_type(make_a().method())  # expected: int
```

### Sparse expectation

```txt
query A:
  export surface: complete
  name is present
  sparse result: positive candidate or fallback: incompleteIndex

query make_a:
  export surface: complete
  name is present
  sparse result: positive candidate or fallback: incompleteIndex
```

The current scaffold should still fallback for positives because it stores export names but does not yet hold trusted resolved symbols.

## Example 2: Static `__all__`, Missing Name

### `lib_static_all_missing.py`

```py
__all__ = ["A"]

class A:
    pass

class Hidden:
    pass
```

### `app.py`

```py
from lib_static_all_missing import *

reveal_type(A)       # expected: type[A]
reveal_type(Hidden)  # expected diagnostic: Hidden is not defined
```

### Sparse expectation

```txt
query Hidden:
  export surface: complete
  name is absent
  sparse result: notFound
  negative cache: populated
```

This is the key safe negative case. Because static `__all__` is complete, absence can be answered without full wildcard expansion.

## Example 3: Dynamic `__all__`

### `lib_dynamic_all.py`

```py
_names = ["A"]
__all__ = [name for name in _names]

class A:
    pass

class MaybeExported:
    pass
```

### `app.py`

```py
from lib_dynamic_all import *

reveal_type(A)
reveal_type(MaybeExported)
```

### Sparse expectation

```txt
query A:
  export surface: unknown
  sparse result: fallback: dynamicAll

query MaybeExported:
  export surface: unknown
  sparse result: fallback: dynamicAll
```

Dynamic `__all__` must not produce sparse negative results.

## Example 4: No `__all__`, Partial Symbol Table

### `lib_no_all.py`

```py
class A:
    pass

class _Private:
    pass

VALUE: int = 1
```

### `app.py`

```py
from lib_no_all import *

reveal_type(A)      # expected: type[A]
reveal_type(VALUE)  # expected: int
reveal_type(MissingName)  # expected diagnostic: MissingName is not defined
```

### Sparse expectation

```txt
query A:
  export surface: partial
  name is present in symbol table
  sparse result: positive candidate or fallback: incompleteIndex

query VALUE:
  export surface: partial
  name is present in symbol table
  sparse result: positive candidate or fallback: incompleteIndex

query MissingName:
  export surface: partial
  name is absent
  sparse result: fallback: incompleteIndex
  negative cache: not populated
```

Without static `__all__`, absence is not safe enough for a sparse negative answer.

## Example 5: Re-export Through Static `__all__`

### `inner.py`

```py
class A:
    pass
```

### `outer.py`

```py
from inner import A

__all__ = ["A"]
```

### `app.py`

```py
from outer import *

reveal_type(A)  # expected: type[A]
```

### Sparse expectation

```txt
query A:
  export surface: complete for outer
  name is present
  sparse result: positive candidate or fallback until re-export target can be resolved per-name
```

The sparse resolver may know that `A` is exported by `outer`, but final symbol resolution should be delegated to existing import/binder logic.

## Example 6: Re-export Missing From Static `__all__`

### `outer_missing.py`

```py
from inner import A, B

__all__ = ["A"]
```

### `app.py`

```py
from outer_missing import *

reveal_type(A)  # expected: type[A]
reveal_type(B)  # expected diagnostic: B is not defined
```

### Sparse expectation

```txt
query B:
  export surface: complete
  name is absent from __all__
  sparse result: notFound
```

Even if `B` exists in `outer_missing`'s local symbol table, static `__all__` controls wildcard exports.

## Example 7: Conditional Export

### `lib_conditional.py`

```py
import sys

if sys.version_info >= (3, 12):
    class A:
        pass
else:
    class B:
        pass
```

### `app.py`

```py
from lib_conditional import *

reveal_type(A)
reveal_type(B)
```

### Sparse expectation

```txt
query A or B:
  export surface: partial or unknown
  sparse result: fallback
```

The resolver should not guess based on syntax alone. It needs environment-aware binder metadata before answering.

## Example 8: Stub File Static Export

### `lib_stubbed.pyi`

```py
__all__: list[str]

class A: ...
class B: ...
```

### `lib_stubbed.py`

```py
class A:
    pass

class B:
    pass
```

### `app.py`

```py
from lib_stubbed import *

reveal_type(A)
reveal_type(B)
reveal_type(C)
```

### Sparse expectation

```txt
query C:
  export surface: unknown or partial
  sparse result: fallback
```

A stub annotation like `__all__: list[str]` does not provide a complete export list. It must not enable negative sparse answers.

## Example 9: Stub File Literal `__all__`

### `lib_stubbed_static.pyi`

```py
__all__ = ["A"]

class A: ...
class Hidden: ...
```

### `app.py`

```py
from lib_stubbed_static import *

reveal_type(A)       # expected: type[A]
reveal_type(Hidden)  # expected diagnostic: Hidden is not defined
```

### Sparse expectation

```txt
query Hidden:
  export surface: complete
  name is absent
  sparse result: notFound
```

A literal `__all__` in a stub is a strong candidate for a complete export surface.

## Example 10: Package `__init__` Re-export

### `pkg/_types.py`

```py
class DataFrame:
    pass

class Series:
    pass
```

### `pkg/__init__.py`

```py
from ._types import DataFrame, Series

__all__ = ["DataFrame", "Series"]
```

### `app.py`

```py
from pkg import *

reveal_type(DataFrame)  # expected: type[DataFrame]
reveal_type(Series)     # expected: type[Series]
reveal_type(Index)      # expected diagnostic: Index is not defined
```

### Sparse expectation

```txt
query Index:
  export surface: complete
  name is absent
  sparse result: notFound
```

This is a small model of the large-library package surface case.

## Example 11: Large Library Shape

This is not intended to run against a real dependency in unit tests. It models a package like `pandas` or `transformers` with many exports.

### `large_lib/__init__.py`

```py
from .frame import DataFrame
from .series import Series
from .index import Index

__all__ = [
    "DataFrame",
    "Series",
    "Index",
]
```

### `app.py`

```py
from large_lib import *

reveal_type(DataFrame)
```

### Sparse expectation

```txt
query DataFrame:
  export surface: complete
  name is present
  sparse result: positive candidate or fallback until trusted per-name resolution exists
```

Final behavior should avoid binding every export from `large_lib` just to answer `DataFrame`, but only after the positive path delegates to trusted Pyright resolution.

## Example 12: Cache Invalidation

### Initial `lib_cache.py`

```py
__all__ = ["A"]

class A:
    pass
```

### Initial `app.py`

```py
from lib_cache import *

reveal_type(B)  # expected diagnostic: B is not defined
```

Sparse result:

```txt
query B -> notFound
negative cache populated
```

### Modified `lib_cache.py`

```py
__all__ = ["A", "B"]

class A:
    pass

class B:
    pass
```

Expected after invalidation:

```txt
query B:
  previous negative cache entry must be invalidated
  sparse result: positive candidate or fallback
  baseline diagnostic disappears
```

## Proposed Analyzer Sample Layout

Potential future files:

```txt
packages/pyright-internal/src/tests/samples/sparseResolverStaticAll.py
packages/pyright-internal/src/tests/samples/sparseResolverDynamicAll.py
packages/pyright-internal/src/tests/samples/sparseResolverPartialExports.py
packages/pyright-internal/src/tests/samples/sparseResolverReexports.py
packages/pyright-internal/src/tests/samples/sparseResolverCacheInvalidation.py
```

Potential future test entry points:

```ts
test('Sparse resolver static __all__ wildcard import', () => {
    const analysisResults = TestUtils.typeAnalyzeSampleFiles(['sparseResolverStaticAll.py']);
    TestUtils.validateResults(analysisResults, 1);
});
```

For the first behavior-preserving stage, the same sample should pass with sparse resolver off, logging-only, and enabled. Enabled mode should initially behave like fallback-only until positive per-name resolution is implemented.
