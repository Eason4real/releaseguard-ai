type JudgmentExplanationProps = {
  question: string;
  why: string;
  basis: readonly string[];
  note?: string;
  tone?: "default" | "caution" | "success";
  className?: string;
};

export default function JudgmentExplanation({
  question,
  why,
  basis,
  note,
  tone = "default",
  className = "",
}: JudgmentExplanationProps) {
  return <section className={`judgment-explanation ${tone} ${className}`.trim()}>
    <div className="judgment-explanation-copy">
      <span>为什么</span>
      <h3>{question}</h3>
      <p>{why}</p>
      {note && <small>{note}</small>}
    </div>
    <details>
      <summary>查看依据 <span aria-hidden="true">+</span></summary>
      <ul>{basis.map((item) => <li key={item}>{item}</li>)}</ul>
    </details>
  </section>;
}
