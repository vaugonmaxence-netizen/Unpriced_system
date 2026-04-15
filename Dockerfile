FROM node:18-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
COPY . .

RUN pip3 install anthropic --break-system-packages

CMD sh -c "python3 train.py && python3 api.py & sleep 2 && node scanner_v3.js"
