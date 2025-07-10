# Complex test file for memory leak testing - this should create significant type cache entries
from typing import List, Dict, Optional, Union, Generic, TypeVar, Callable, Tuple, Any, Literal, overload, AsyncGenerator
from typing_extensions import TypedDict, ParamSpec, TypeVarTuple, Unpack
from abc import ABC, abstractmethod
import asyncio

T = TypeVar('T')
U = TypeVar('U') 
V = TypeVar('V')
P = ParamSpec('P')
Ts = TypeVarTuple('Ts')

# Complex recursive generic types that will create many cache entries
class Node(Generic[T]):
    def __init__(self, value: T, children: Optional[List['Node[T]']] = None) -> None:
        self.value = value
        self.children = children or []
    
    def add_child(self, child: 'Node[T]') -> None:
        self.children.append(child)
    
    def transform(self, func: Callable[[T], U]) -> 'Node[U]':
        new_children = [child.transform(func) for child in self.children]
        return Node(func(self.value), new_children)

# Complex inheritance with multiple generics
class BaseProcessor(ABC, Generic[T, U]):
    @abstractmethod
    def process(self, input_data: T) -> U: ...
    
    @abstractmethod
    def batch_process(self, items: List[T]) -> Dict[str, U]: ...

class StringProcessor(BaseProcessor[str, int]):
    def process(self, input_data: str) -> int:
        return len(input_data)
    
    def batch_process(self, items: List[str]) -> Dict[str, int]:
        return {item: self.process(item) for item in items}

class ListProcessor(BaseProcessor[List[T], Dict[T, int]], Generic[T]):
    def process(self, input_data: List[T]) -> Dict[T, int]:
        return {item: hash(str(item)) for item in input_data}
    
    def batch_process(self, items: List[List[T]]) -> Dict[str, Dict[T, int]]:
        return {f"batch_{i}": self.process(batch) for i, batch in enumerate(items)}

# Overloaded functions with complex signatures
@overload
def complex_transform(data: str, processor: Callable[[str], int]) -> Node[int]: ...
@overload 
def complex_transform(data: List[T], processor: Callable[[T], U]) -> Node[Dict[T, U]]: ...
@overload
def complex_transform(data: Dict[str, T], processor: Callable[[T], U]) -> Node[List[Tuple[str, U]]]: ...

def complex_transform(data, processor):
    if isinstance(data, str):
        return Node(processor(data))
    elif isinstance(data, list):
        return Node({item: processor(item) for item in data})
    elif isinstance(data, dict):
        return Node([(k, processor(v)) for k, v in data.items()])

# TypedDict with nested complexity
class PersonData(TypedDict):
    name: str
    age: int
    addresses: List[Dict[str, Union[str, int]]]
    preferences: Dict[Literal["theme", "language", "timezone"], str]

class CompanyData(TypedDict):
    employees: List[PersonData]
    departments: Dict[str, List[PersonData]]
    metadata: Dict[str, Any]

# Complex async generators and coroutines
async def async_node_generator(
    root: Node[T], 
    transform: Callable[[T], Callable[[], U]]
) -> AsyncGenerator[Node[U], None]:
    stack: List[Node[T]] = [root]
    while stack:
        current = stack.pop()
        transformed_value = await asyncio.to_thread(transform(current.value))
        yield Node(transformed_value)
        stack.extend(current.children)

# Highly nested generic function with complex constraints
def ultra_complex_processor(
    data: Dict[str, List[Tuple[T, Optional[Callable[[T], U]]]]],
    fallback: Callable[[T], U],
    validator: Callable[[U], bool]
) -> Dict[str, List[Tuple[T, U]]]:
    result = {}
    for key, items in data.items():
        processed_items = []
        for item, transform_func in items:
            if transform_func is not None:
                processed = transform_func(item)
            else:
                processed = fallback(item)
            
            if validator(processed):
                processed_items.append((item, processed))
        result[key] = processed_items
    return result

# Create many instances to stress the type cache
processors = [
    StringProcessor(),
    ListProcessor[str](),
    ListProcessor[int](),
    ListProcessor[Tuple[str, int]](),
]

# Complex nested structures
nested_data: Dict[str, List[Tuple[Union[str, int], Optional[Callable[[Union[str, int]], str]]]]] = {
    "group1": [(42, str), ("hello", lambda x: str(x).upper())],
    "group2": [(100, None), ("world", str)],
}

# Create complex node trees
string_nodes = [Node(f"item_{i}") for i in range(20)]
int_nodes = [Node(i * 2) for i in range(20)]
tuple_nodes = [Node((f"key_{i}", i)) for i in range(20)]

# Complex comprehensions that will exercise type inference heavily
complex_mapping = {
    f"key_{i}": [
        complex_transform(
            [f"sub_{j}" for j in range(5)],
            lambda x: len(x) * i
        ) 
        for i in range(10)
    ] 
    for i in range(15)
}

# Protocol and runtime type checking
from typing import Protocol

class Processable(Protocol[T]):
    def process_item(self, item: T) -> Dict[str, Any]: ...
    def get_metadata(self) -> Dict[str, Union[str, int, bool]]: ...

class ConcreteProcessor:
    def process_item(self, item: Any) -> Dict[str, Any]:
        return {"processed": str(item), "type": type(item).__name__}
    
    def get_metadata(self) -> Dict[str, Union[str, int, bool]]:
        return {"version": 1, "active": True, "name": "ConcreteProcessor"}

# More type variable constraints and complex generic hierarchies
K = TypeVar('K', bound=Union[str, int])
V = TypeVar('V', bound=Dict[str, Any])

class GenericCache(Generic[K, V]):
    def __init__(self) -> None:
        self._data: Dict[K, V] = {}
        self._metadata: Dict[K, Dict[str, Union[int, str, bool]]] = {}
    
    def store(self, key: K, value: V, tags: List[str] = None) -> None:
        self._data[key] = value
        self._metadata[key] = {
            "created": hash(str(key)),
            "tags": str(tags or []),
            "active": True
        }
    
    def retrieve(self, key: K) -> Optional[V]:
        return self._data.get(key)
    
    def batch_retrieve(self, keys: List[K]) -> Dict[K, Optional[V]]:
        return {k: self.retrieve(k) for k in keys}

# Create instances that will force complex type evaluation
caches = [
    GenericCache[str, PersonData](),
    GenericCache[int, CompanyData](), 
    GenericCache[str, Dict[str, List[int]]](),
]

# Force evaluation of all the complex types
processor = ConcreteProcessor()
result1 = processor.process_item("test")
result2 = ultra_complex_processor(nested_data, str, lambda x: len(x) > 0)

# Trigger more complex type inference
for cache in caches:
    if isinstance(cache, GenericCache):
        cache.store("test", {"name": "Test", "age": 30, "addresses": [], "preferences": {"theme": "dark", "language": "en", "timezone": "UTC"}})

final_result = complex_mapping["key_5"][3].transform(lambda x: x * 2)
