import { validateRealPublicCorpus } from "../eval/real-public-rag-eval";

console.log(JSON.stringify(await validateRealPublicCorpus(), null, 2));
