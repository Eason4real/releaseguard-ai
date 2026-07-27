export function tokenize(input: string) {
  const normalized = input.normalize("NFKC").toLowerCase();
  const tokens: string[] = normalized.match(/[a-z0-9]+(?:[._:-][a-z0-9]+)*/g) ?? [];
  const cjk = [...normalized].filter((char) => /[\u3400-\u9fff]/u.test(char));
  for (let index = 0; index < cjk.length - 1; index += 1) {
    tokens.push(`${cjk[index]}${cjk[index + 1]}`);
  }
  return tokens.filter((token) => token.length > 1);
}

export function termFrequency(input: string) {
  const frequencies = new Map<string, number>();
  for (const token of tokenize(input)) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
