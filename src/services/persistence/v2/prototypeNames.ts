/**
 * The one name this application refuses to adopt as a key, and the rule that finds it.
 *
 * ## Why this is its own module
 *
 * The rule started in `products/archiveValidation.ts`, where it was a guard on ZIP **member
 * names**: `__proto__` cannot be an ordinary own key, because assigning it changes the
 * object's prototype instead of adding a member, and every other `Object.prototype` name
 * shadows an inherited method. It was correct there and it stayed correct as more callers
 * adopted it - a generation label this product writes, a room id this product mints, a tag
 * this product indexes.
 *
 * And then it became a problem. `archiveValidation.ts` imports the ZIP codec, so a module
 * that needed only this one function inherited `fflate` in its transitive closure and in
 * whatever bundle chunk it ended up in. Phase 7's `.kdtemplate` product found this: the
 * boundary gate asserts the product needs no archive codec, and the only path to
 * `v2/archive.ts` was `subjectTemplate.ts` → `archiveValidation.ts` → `archive.ts`, for a
 * two-clause function. A JSON product that loads a ZIP codec to ask "is this string a
 * prototype name" is a real cost, not a theoretical one.
 *
 * So the rule moved here, to a leaf in the storage-v2 tree that imports nothing. Every
 * existing importer is unaffected: `archiveValidation.ts` re-exports
 * {@link isPrototypeMemberName}, and `archive.ts` re-exports
 * {@link UNREPRESENTABLE_MEMBER_NAME}, so no call site and no gate had to change. The
 * codec keeps its own richer comment on the constant and this file keeps the general one.
 *
 * Renderer-neutral, no clock, no storage access, and the function is a pure predicate over
 * one string.
 */

/**
 * The one name whose assignment has a side effect.
 *
 * Every other name on `Object.prototype` is an ordinary string: it can be a value, and it
 * can be a key - it merely shadows an inherited method. `__proto__` is different in kind. It
 * is an accessor on `Object.prototype`, so `target['__proto__'] = value` walks the
 * prototype chain and either replaces the object's prototype or is ignored, and in both
 * cases the assignment that was supposed to add a member adds nothing and reports nothing.
 */
export const UNREPRESENTABLE_MEMBER_NAME = '__proto__';

/**
 * Whether a name is one that cannot be an ordinary own key of a plain object.
 *
 * `__proto__` changes an object's prototype instead of adding a member, and the rest of
 * `Object.prototype`'s own names shadow inherited methods. A name this product adopts from
 * an untrusted source - an archive member, a generation label, a room identifier, a tag - is
 * attacker-controlled, so both are refused rather than indexed.
 *
 * `Object.hasOwn` rather than `in`, deliberately: `in` walks the prototype chain, so it
 * would answer `true` for a name inherited from somewhere else and refuse it for the wrong
 * reason. The check is about the two objects in question, not about any prototype.
 */
export function isPrototypeMemberName(name: string): boolean {
  return name === UNREPRESENTABLE_MEMBER_NAME || Object.hasOwn(Object.prototype, name);
}
