FROM node:18-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .
RUN pip3 install anthropic --break-system-packages
RUN chmod +x start.sh

CMD ["bash", "start.sh"]

