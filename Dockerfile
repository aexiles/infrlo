FROM node:alpine3.22

WORKDIR /tmp

COPY index.js index.html package.json shell.js ./
COPY public ./public

EXPOSE 3000/tcp

RUN apk update && apk upgrade &&\
    apk add --no-cache openssl curl gcompat iproute2 coreutils &&\
    apk add --no-cache bash &&\
    apk add --no-cache --virtual .build-deps build-base python3 linux-headers &&\
    chmod +x index.js &&\
    npm install &&\
    apk del .build-deps

CMD ["node", "index.js"]
