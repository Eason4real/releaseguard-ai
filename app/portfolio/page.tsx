import type { Metadata } from "next";
import styles from "./portfolio.module.css";

export const metadata: Metadata = {
  title: "李超｜AI 产品经理作品集",
  description:
    "李超 AI 产品经理 2027 校招项目作品集，包含 ReleaseGuard AI 与 AI 智能客服质检项目。",
  authors: [{ name: "李超" }],
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    title: "李超｜AI 产品经理作品集",
    description:
      "李超 AI 产品经理 2027 校招项目作品集，包含 ReleaseGuard AI 与 AI 智能客服质检项目。",
  },
};

const pages = Array.from({ length: 8 }, (_, index) => index + 1);

export default function PortfolioPage() {
  return (
    <div className={styles.site}>
      <h1 className={styles.srOnly}>李超｜AI 产品经理作品集</h1>
      <main className={styles.portfolio} aria-label="作品集，共 8 页">
        {pages.map((page) => {
          const number = String(page).padStart(2, "0");

          return (
            <figure className={styles.page} key={page}>
              {/* eslint-disable-next-line @next/next/no-img-element -- Preserve the pre-compressed portfolio page exactly. */}
              <img
                src={`/portfolio-assets/page-${number}.webp`}
                width={2400}
                height={1350}
                alt={`李超 AI 产品经理作品集第 ${page} 页`}
                loading={page === 1 ? "eager" : "lazy"}
                fetchPriority={page === 1 ? "high" : undefined}
                decoding={page === 1 ? "sync" : "async"}
              />
            </figure>
          );
        })}
      </main>
      <footer className={styles.projectLinks}>
        <h2>项目链接</h2>
        <nav aria-label="作品集项目链接">
          <a
            href="https://releaseguard.easonchao.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            ReleaseGuard AI 在线 Demo
          </a>
          <a
            href="https://github.com/Eason4real/releaseguard-ai"
            target="_blank"
            rel="noopener noreferrer"
          >
            ReleaseGuard AI GitHub
          </a>
        </nav>
      </footer>
    </div>
  );
}
