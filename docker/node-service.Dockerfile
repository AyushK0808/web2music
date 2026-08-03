# Shared image for Web2Music's zero-dependency Node microservices
# (services/embed, services/classify). Both are a single .js file plus a
# package.json declaring `npm start` — this Dockerfile only needs to know
# which one to copy in and which port to expose.
#
# Built from the repo root as build context (see docker-compose.yml), so
# SERVICE selects the subdirectory under services/.
FROM node:20-alpine

ARG SERVICE
ARG PORT
ENV PORT=${PORT}

WORKDIR /app

COPY services/${SERVICE}/package.json ./
COPY services/${SERVICE}/*.js ./

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
