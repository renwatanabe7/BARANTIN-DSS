@import "tailwindcss";

@theme {
  --animate-loading: loading 150s linear forwards;
  --animate-loading-long: loading 300s linear forwards;
  --animate-loading-fast: loading 30s linear forwards;

  @keyframes loading {
    from { width: 0%; }
    to { width: 100%; }
  }
}
