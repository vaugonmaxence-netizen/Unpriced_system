FROM node:18-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN pip3 install anthropic --break-system-packages
RUN npm install

CMD python3 train.py && python3 api.py & node scanner_v3.js
