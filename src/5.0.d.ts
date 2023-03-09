export {}

declare global {
  interface Array<T> {
    findLastIndex: Array<T>["findIndex"]
    findLast: Array<T>["find"];
  }
}