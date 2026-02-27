/*
 * constraintSolution.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Data structure that holds one or more constraint solutions for a set
 * of type variables.
 */

import { assert } from '../common/debug';
import { FunctionType, ParamSpecType, Type, TypeVarType } from './types';

// Records the types associated with a set of type variables.
export class ConstraintSolutionSet {
    // Indexed by TypeVar ID.
    private _typeVarMap: Map<string, Type | undefined>;

    constructor() {
        this._typeVarMap = new Map();
    }

    isEmpty() {
        return this._typeVarMap.size === 0;
    }

    getType(typeVar: ParamSpecType): FunctionType | undefined;
    getType(typeVar: TypeVarType): Type | undefined;
    getType(typeVar: TypeVarType): Type | undefined {
        const key = TypeVarType.getNameWithScope(typeVar);
        return this._typeVarMap.get(key);
    }

    setType(typeVar: TypeVarType, type: Type | undefined) {
        const key = TypeVarType.getNameWithScope(typeVar);
        return this._typeVarMap.set(key, type);
    }

    hasType(typeVar: TypeVarType): boolean {
        const key = TypeVarType.getNameWithScope(typeVar);
        return this._typeVarMap.has(key);
    }

    doForEachTypeVar(callback: (type: Type, typeVarId: string) => void) {
        for (const [key, type] of this._typeVarMap) {
            if (type) {
                callback(type, key);
            }
        }
    }
}

export class ConstraintSolution {
    private _solutionSets: ConstraintSolutionSet[];

    constructor(solutionSets?: ConstraintSolutionSet[]) {
        this._solutionSets =
            solutionSets && solutionSets.length > 0 ? [...solutionSets] : [new ConstraintSolutionSet()];
    }

    isEmpty() {
        for (const set of this._solutionSets) {
            if (!set.isEmpty()) {
                return false;
            }
        }
        return true;
    }

    setType(typeVar: TypeVarType, type: Type) {
        for (const set of this._solutionSets) {
            set.setType(typeVar, type);
        }
    }

    getMainSolutionSet() {
        return this.getSolutionSet(0);
    }

    getSolutionSets() {
        return this._solutionSets;
    }

    doForEachSolutionSet(callback: (solutionSet: ConstraintSolutionSet, index: number) => void) {
        const sets = this.getSolutionSets();
        for (let index = 0; index < sets.length; index++) {
            callback(sets[index], index);
        }
    }

    getSolutionSet(index: number) {
        assert(index >= 0 && index < this._solutionSets.length);
        return this._solutionSets[index];
    }
}
