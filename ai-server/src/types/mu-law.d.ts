declare module 'mu-law' {
  export function encode(pcm: Int16Array | ArrayLike<number>): Uint8Array;
  export function decode(mulaw: Uint8Array | ArrayLike<number>): Int16Array;
}
