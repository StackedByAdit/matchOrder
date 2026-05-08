import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";
import { FILLS, ORDERBOOKS } from "./store/exchange-store.js";

export type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order";

export interface EngineRequest {
  correlationId: string;
  responseQueue: string;
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

export interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const brokerClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis broker client error", error);
});

const responseClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis response client error", error);
});

await Promise.all([brokerClient.connect(), responseClient.connect()]);

// :-)) I added this just to check the flow, remove it when you start
const DUMMY_SELL_ORDER = {
  orderId: "dummy-sell-order-1",
  userId: "dummy-seller",
  type: "limit",
  side: "sell",
  symbol: "BTC",
  price: 100,
  qty: 1,
  filledQty: 0,
  status: "open",
};

async function sendResponse(responseQueue: string, response: EngineResponse): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

function handleEngineRequest(message: EngineRequest): unknown {
  /**
   * TODO(student):
   * 1. Check _message.type.
   * 2. Read _message.payload.
   * 3. Call your order book / balance / order logic.
   * 4. Return the data that should go back to the backend.
   *
   * Required message types:
   * - create_order
   * - get_depth
   * - get_user_balance
   * - get_order
   * - cancel_order
   */

  const {
    userId,
    symbol,
    side,
    type,
    price,
    qty,
  } = message.payload as {
    userId: string;
    symbol: string;
    side: "buy" | "sell";
    type: "limit" | "market";
    price: number;
    qty: number;
  };

  const order = {
    orderId: crypto.randomUUID(),
    userId,
    symbol,
    side,
    type,
    price,
    qty,
    filledQty: 0,
    status: "open",
  };

  const firm = ORDERBOOKS.get(symbol);

  if (!firm) {
    return;
  }

  if (side === "buy") {

    const askPrices = Object.keys(firm.asks)

    const pricesToNumber = askPrices.map((str) => Number(str));

    pricesToNumber.sort((a, b) => a - b);

    for (const askPrice of pricesToNumber) {

      if (type === "limit" && askPrice > price) {
        break;
      }

      const ordersAtPrice = firm.asks.get(price);
      if (!ordersAtPrice) continue;

      const sellOrder = ordersAtPrice[0];
      if (!sellOrder) break;

      const remainingBuy = order.qty - order.filledQty;
      const remainingSell = sellOrder.qty - sellOrder.filledQty;
      const tradeQty = Math.min(remainingBuy, remainingSell);

      order.filledQty += tradeQty;
      sellOrder.filledQty += tradeQty;

      FILLS.push({
        fillId: crypto.randomUUID(),
        symbol: symbol,
        price: price,
        qty: tradeQty,
        buyOrderId: userId,
        sellOrderId: sellOrder.userId,
        createdAt: Date.now()
      });

      if (ordersAtPrice.length === 0) {
        firm.bids.delete(askPrice);
      }
    }

    if (!firm) {
      throw new Error("Invalid symbol");
    }

  } else {

  if (side === "sell") {

    const bidPrices = Object.keys(firm.bids)

    const pricesToNumber = bidPrices.map((str) => Number(str));

    pricesToNumber.sort((a, b) => b - a);

    let remainingQty = qty;

    for (const bidPrice of pricesToNumber) {

      if (type === "limit" && bidPrice < price) {
        break;
      }

      const ordersAtPrice = firm.bids.get(bidPrice);

      if (!ordersAtPrice) continue;

      for (const buyOrder of ordersAtPrice) {

        if (remainingQty <= 0) break;

        const availableQty =
          buyOrder.qty - buyOrder.filledQty;

        const matchedQty = Math.min(
          remainingQty,
          availableQty
        );

        buyOrder.filledQty += matchedQty;

        remainingQty -= matchedQty;

        FILLS.push({
          fillId: crypto.randomUUID(),
          symbol: symbol,
          price: bidPrice,
          qty: matchedQty,
          buyOrderId: buyOrder.userId,
          sellOrderId: userId,
          createdAt: Date.now()
        });

        if (buyOrder.filledQty === buyOrder.qty) {
          buyOrder.status = "filled";
        } else {
          buyOrder.status = "partially_filled";
        }
      }

      if (ordersAtPrice.length === 0) {
        firm.bids.delete(bidPrice);
      }


      if (remainingQty <= 0) break;
    }

    order.filledQty = qty - remainingQty;

    if (remainingQty === 0) {
      order.status = "filled";
    } else if (order.filledQty > 0) {
      order.status = "partially_filled";
    }
  }

}

  // just checking the flow, remove this when you start implementing the logic
  if (message.type === "create_order") {
    return {
      orderId: crypto.randomUUID(),
      status: "filled",
      filledQty: DUMMY_SELL_ORDER.qty,
      averagePrice: DUMMY_SELL_ORDER.price,
      fills: [
        {
          fillId: crypto.randomUUID(),
          symbol: DUMMY_SELL_ORDER.symbol,
          price: DUMMY_SELL_ORDER.price,
          qty: DUMMY_SELL_ORDER.qty,
          buyOrderId: "request-buy-order",
          sellOrderId: DUMMY_SELL_ORDER.orderId,
        },
      ],
      note: "Smoke-test response only. Students must replace this with real matching logic.",
    };
  }

  throw new Error("TODO(student): implement this engine request type");
}

console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

for (; ;) {
  const item = await brokerClient.brPop(env.incomingQueue, 0);
  if (!item) continue;

  let message: EngineRequest;

  try {
    message = JSON.parse(item.element) as EngineRequest;
  } catch {
    console.error("Skipping invalid broker message");
    continue;
  }

  try {
    const data = handleEngineRequest(message);
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: true,
      data,
    });
  } catch (error) {
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    });
  }
}