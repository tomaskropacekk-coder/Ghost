import { z } from 'zod';

export const optimization = z
  .looseObject({
    members: z
      .looseObject({
        hintFreeSubscriberPage: z.boolean().optional().meta({
          description:
            'Enables a MySQL hint for shallow pages of free, email-enabled members subscribed to an active newsletter. Enable per site after verifying that matches are common among recent members. Sparse matches can make the date-index scan slower.',
        }),
      })
      .optional(),
  })
  .optional();
