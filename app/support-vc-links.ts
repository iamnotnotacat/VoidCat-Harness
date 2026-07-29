export type SupportVcLink = {
  id: "cash-app" | "library" | "main-site";
  title: string;
  url: string;
  description: string;
  primary: boolean;
  handle?: string;
};

export const SUPPORT_VC_LINKS: readonly SupportVcLink[] = [
  {
    id: "cash-app",
    title: "Donate via Cash App",
    url: "https://cash.app/$rabbitinthehand",
    handle: "$rabbitinthehand",
    description: "This app is free and funded entirely by people who want it to exist. Any amount helps cover hosting, development time, and keeping it ad-free.",
    primary: true,
  },
  {
    id: "library",
    title: "The New Library of Alexandria",
    url: "https://library.iamnotnotacat.com",
    description: "A communal digital library for reading, annotating, and writing in the open. Public domain books plus original work from the community, with margin notes and per-book conversation.",
    primary: false,
  },
  {
    id: "main-site",
    title: "iamnotnotacat.com",
    url: "https://iamnotnotacat.com",
    description: "My main site — occult streetwear, alternative culture, and the rest of the projects I'm building under Claw & Riot.",
    primary: false,
  },
] as const;
