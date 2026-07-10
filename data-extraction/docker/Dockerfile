# Feature A embedding microservice — keeps the OpenAI API key server-side.
FROM node:20-alpine

WORKDIR /app

# No external dependencies (built-in http + global fetch), so copying package
# metadata + source is enough. Kept as a distinct layer for cache friendliness.
COPY package.json ./
COPY embedService.js ./

ENV PORT=8077
EXPOSE 8077

# Basic liveness check against the service's own /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8077)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "embedService.js"]
