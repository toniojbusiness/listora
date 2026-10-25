import type {
  Today,
  TodayCard as ContractCard,
  TodayItem,
  TodayMoneyPeriod,
  TodaySummarySettings,
} from '@listora/api-contract';
import { assertNever } from '@listora/shared';
import type {
  MoneyPeriod,
  TodayCard,
  TodayItemRef,
  TodaySummary,
  TodaySummarySettings as Settings,
} from '@listora/today';

import { photoFromRow, type PhotoRow, type PublicUrls } from '../photos/mapping.ts';

/** The contract's `Today`; `covers` holds the cards' items' cover photos. */
export function todayView(
  summary: TodaySummary,
  covers: ReadonlyMap<string, PhotoRow>,
  urls: PublicUrls,
): Today {
  const currency = summary.money.currency;
  const period = (value: MoneyPeriod): TodayMoneyPeriod => ({
    start: value.start.toISOString(),
    end: value.end.toISOString(),
    sales: value.sales,
    itemsSold: value.itemsSold,
    salesTotal: { amountCents: value.salesCents, currency },
    ...(value.profitCents === null ? {} : { profit: { amountCents: value.profitCents, currency } }),
    profitPendingSales: value.profitPendingSales,
  });
  return {
    generatedAt: summary.generatedAt.toISOString(),
    cards: summary.cards.map((card) => cardView(card, covers, urls)),
    money: { thisWeek: period(summary.money.thisWeek), lastWeek: period(summary.money.lastWeek) },
  };
}

function cardView(
  card: TodayCard,
  covers: ReadonlyMap<string, PhotoRow>,
  urls: PublicUrls,
): ContractCard {
  const base: ContractCard = {
    id: card.id,
    kind: card.kind,
    urgency: card.urgency,
    title: card.title,
    ...(card.detail === null ? {} : { detail: card.detail }),
    action: {
      label: card.action.label,
      destination: card.action.destination,
      ...(card.action.itemId === null ? {} : { itemId: card.action.itemId }),
      ...(card.action.saleId === null ? {} : { saleId: card.action.saleId }),
      ...(card.action.connectionId === null ? {} : { connectionId: card.action.connectionId }),
    },
  };
  const item = (ref: TodayItemRef): TodayItem => {
    const cover = covers.get(ref.id);
    const thumbnail = cover === undefined ? undefined : photoFromRow(cover, urls).urls?.thumbnail;
    return {
      id: ref.id,
      sku: ref.sku,
      ...(ref.title === null || ref.title.trim() === '' ? {} : { title: ref.title }),
      ...(thumbnail === undefined ? {} : { thumbnailUrl: thumbnail }),
    };
  };
  switch (card.kind) {
    case 'ship':
      return {
        ...base,
        item: item(card.item),
        shipment: {
          saleId: card.saleId,
          marketplace: card.marketplace,
          soldAt: card.soldAt.toISOString(),
          ...(card.shipBy === null ? {} : { shipBy: card.shipBy.toISOString() }),
          ...(card.location === null
            ? {}
            : {
                location: {
                  code: card.location.code,
                  ...(card.location.label === null ? {} : { label: card.location.label }),
                },
              }),
        },
      };
    case 'delist':
      return {
        ...base,
        item: item(card.item),
        delist: {
          saleId: card.saleId,
          delistRunId: card.delistRunId,
          soldOn: card.soldOn,
          statusDisplay: card.status,
          remaining: card.remaining,
        },
      };
    case 'reconnect':
      return {
        ...base,
        connection: {
          connectionId: card.connectionId,
          marketplace: card.marketplace,
          ...(card.displayName === null ? {} : { displayName: card.displayName }),
          status: card.status,
        },
      };
    case 'stale_listing': {
      const money = (amountCents: number) => ({ amountCents, currency: card.currency });
      return {
        ...base,
        item: item(card.item),
        staleListing: {
          listedAt: card.listedAt.toISOString(),
          daysListed: card.daysListed,
          price: money(card.priceCents),
          ...(card.floorCents === null ? {} : { floor: money(card.floorCents) }),
          suggestion: card.suggestion.kind,
          ...(card.suggestion.kind === 'price_drop'
            ? { suggestedPrice: money(card.suggestion.priceCents) }
            : {}),
          marketplaces: card.marketplaces,
        },
      };
    }
    case 'review_drafts':
      return {
        ...base,
        drafts: { count: card.count, oldestCreatedAt: card.oldestCreatedAt.toISOString() },
      };
    default:
      return assertNever(card, 'Today card');
  }
}

export function summarySettingsView(settings: Settings): TodaySummarySettings {
  return {
    enabled: settings.enabled,
    time: settings.localTime,
    ...(settings.timeZone === null ? {} : { timeZone: settings.timeZone }),
  };
}
