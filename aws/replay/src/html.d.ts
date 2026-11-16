// esbuild 以 text loader 把 .html 嵌成字串（見 scripts/build.mjs）
declare module '*.html' {
  const content: string;
  export default content;
}
